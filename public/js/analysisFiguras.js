// --------------------------------------------------------------------
// Análisis de publicación (fase F2): verificados y figuras públicas.
// Prefijo ana / ANA_ (comparte el ámbito con analysis.js y
// analysisBlocks.js, que van antes).
//
// - La tarjeta "Verificados y figuras públicas" (anaRenderPeople): los de
//   vista.quienHablo, por likes. Un clic en el nombre muestra sus
//   comentarios abajo. Una sugerida del modelo se confirma, se edita o se
//   descarta ahí mismo; una del equipo se edita (y se quita); un
//   verificado sin ficha se agrega a la lista.
// - "Lista de figuras" (el <dialog> #anaFigDlg): todas, del equipo,
//   sugeridas y descartadas, con buscar, agregar, editar, confirmar,
//   descartar, restaurar y quitar.
// Todo por /api/figuras (src/figurasRoutes.js): la validación (roles, la
// alineación solo para roles políticos o de prensa) es del servidor, que
// responde el mensaje para la persona. Después de un cambio se vuelve a
// leer el análisis a la vista: la vista, el informe y los KPI cambian.
// A los vecinos comunes no se los etiqueta: solo se edita a quien comentó
// verificado o ya está en la lista.
// --------------------------------------------------------------------

const anaF = {
  people: document.getElementById('anaPeople'),
  hint: document.getElementById('anaVerHint'),
  open: document.getElementById('anaFigOpen'),
  dlg: document.getElementById('anaFigDlg'),
  close: document.getElementById('anaFigClose'),
  q: document.getElementById('anaFigQ'),
  add: document.getElementById('anaFigAdd'),
  formBox: document.getElementById('anaFigFormBox'),
  msg: document.getElementById('anaFigMsg'),
  list: document.getElementById('anaFigList'),
};

let anaFigCatalogo = null; // { roles, alineaciones, conAlineacion }
let anaFigLista = []; // GET /api/figuras
let anaFigListaLista = null; // la promesa de la carga en curso
let anaFigEditando = null; // el usuario con el formulario abierto en la tarjeta
let anaFigQuitando = null; // el usuario que pregunta "¿Quitar?" en la tarjeta
let anaFigDlgEditando = null; // en el diálogo
let anaFigDlgQuitando = null;
let anaFigCambio = false; // algo cambió con el diálogo abierto
let anaFigOpener = null;

function anaFigCargar() {
  anaFigListaLista = anaApi('/api/figuras').then((d) => {
    anaFigCatalogo = { roles: d.roles || {}, alineaciones: d.alineaciones || {}, conAlineacion: new Set(d.rolesConAlineacion || []) };
    anaFigLista = d.figuras || [];
    return d;
  });
  return anaFigListaLista;
}

function anaFigDe(usuario) {
  const u = String(usuario || '').toLowerCase();
  return anaFigLista.find((f) => f.username === u) || null;
}

/** "Periodista · oposición"; la clave cruda si todavía no llegó el catálogo. */
function anaRolTexto(f) {
  if (!f || !f.rol) return '';
  const roles = anaFigCatalogo ? anaFigCatalogo.roles : {};
  const al = anaFigCatalogo ? anaFigCatalogo.alineaciones : {};
  return `${roles[f.rol] || f.rol}${f.alineacion ? ` · ${al[f.alineacion] || f.alineacion}` : ''}`;
}

function anaRolChip(f, { sugerida = false } = {}) {
  const chip = anaEl('span', `an-rl${f.alineacion ? ` ${f.alineacion}` : ''}${sugerida ? ' sug' : ''}`, `${sugerida ? 'sugerido: ' : ''}${anaRolTexto(f)}`);
  if (sugerida) chip.dataset.tip = 'Lo sugirió el modelo: confirmalo, editalo o descartalo';
  return chip;
}

function anaBtn(texto, clase = 'btn sm') {
  const b = anaEl('button', clase, texto);
  b.type = 'button';
  return b;
}

// ---------------------------------------------------------------- el formulario

/**
 * El formulario de una figura (nueva o de la tabla), el mismo en la tarjeta
 * y en el diálogo.
 * @param {{ figura: object|null, usuario?: string|null, conUsuario?: boolean, onDone: Function, onCancel: Function }} opts
 */
function anaFigForm({ figura, usuario = null, conUsuario = false, onDone, onCancel }) {
  const form = anaEl('form', 'an-fig-form');
  form.noValidate = true;
  const sufijo = Math.random().toString(36).slice(2, 8);
  const campo = (etiqueta, el, wide = false) => {
    const l = anaEl('label', wide ? 'wide' : '');
    el.id = `anaFig-${etiqueta.toLowerCase().replace(/\W+/g, '')}-${sufijo}`;
    l.htmlFor = el.id;
    l.append(etiqueta, el);
    return l;
  };
  const inUsuario = anaEl('input', 'field');
  inUsuario.type = 'text';
  inUsuario.autocomplete = 'off';
  inUsuario.placeholder = '@usuario';
  inUsuario.maxLength = 31;
  const inNombre = anaEl('input', 'field');
  inNombre.type = 'text';
  inNombre.autocomplete = 'off';
  inNombre.maxLength = 120;
  inNombre.value = (figura && figura.nombre) || '';
  const selRol = anaEl('select', 'field');
  selRol.append(new Option('Elegí un rol', ''));
  for (const [k, texto] of Object.entries(anaFigCatalogo ? anaFigCatalogo.roles : {})) selRol.append(new Option(texto, k));
  selRol.value = (figura && figura.rol) || '';
  const selAl = anaEl('select', 'field');
  selAl.append(new Option('ninguna', ''));
  for (const [k, texto] of Object.entries(anaFigCatalogo ? anaFigCatalogo.alineaciones : {})) selAl.append(new Option(texto, k));
  selAl.value = (figura && figura.alineacion) || '';
  const inNotas = anaEl('textarea', 'field');
  inNotas.rows = 2;
  inNotas.maxLength = 500;
  inNotas.value = (figura && figura.notas) || '';
  // La alineación solo para roles políticos o de prensa (la regla del servidor).
  const syncAl = () => {
    const puede = Boolean(anaFigCatalogo && anaFigCatalogo.conAlineacion.has(selRol.value));
    selAl.disabled = !puede;
    if (!puede) selAl.value = '';
  };
  selRol.addEventListener('change', syncAl);
  syncAl();
  const msg = anaEl('p', 'note msg');
  msg.setAttribute('role', 'status');
  const guardar = anaEl('button', 'btn sm primary', figura && figura.origen === 'sugerida' ? 'Confirmar con estos datos' : 'Guardar');
  guardar.type = 'submit';
  const cancelar = anaBtn('Cancelar', 'btn sm ghost');
  cancelar.addEventListener('click', () => onCancel());
  const acts = anaEl('div', 'acts');
  acts.append(guardar, cancelar);

  if (conUsuario) form.append(campo('Usuario de Instagram', inUsuario));
  form.append(campo('Nombre', inNombre), campo('Rol', selRol), campo('Alineación', selAl), campo('Notas', inNotas, !conUsuario), msg, acts);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = { nombre: inNombre.value.trim(), rol: selRol.value, alineacion: selAl.value || null, notas: inNotas.value.trim() };
    if (!datos.rol) {
      msg.textContent = 'Elegí un rol de la lista.';
      selRol.focus();
      return;
    }
    const u = conUsuario ? inUsuario.value.trim().replace(/^@+/, '') : usuario;
    if (!u) {
      msg.textContent = 'Poné el usuario de Instagram.';
      inUsuario.focus();
      return;
    }
    guardar.disabled = true;
    try {
      // En la tabla (también descartada o sugerida): PATCH la pasa al equipo. Si no, alta.
      const enTabla = figura || anaFigDe(u);
      if (enTabla) await anaApi(`/api/figuras/${encodeURIComponent(enTabla.username)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
      else await anaApi('/api/figuras', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, ...datos }) });
      await onDone(u);
    } catch (err) {
      msg.textContent = err.message;
      guardar.disabled = false;
    }
  });
  requestAnimationFrame(() => (conUsuario ? inUsuario : inNombre).focus());
  return form;
}

/** Un cambio desde la tarjeta: la lista y el análisis a la vista se vuelven a leer. */
async function anaFigDespues(mensaje) {
  await anaFigCargar().catch(() => null);
  if (anaShown) {
    try {
      await anaReloadShown();
    } catch {
      /* queda lo que había */
    }
  }
  anaRefresh();
  if (mensaje) anaToast(mensaje);
}

async function anaFigAccion(usuario, accion) {
  const u = encodeURIComponent(usuario);
  if (accion === 'confirmar' || accion === 'restaurar') {
    await anaApi(`/api/figuras/${u}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return accion === 'confirmar' ? `@${usuario} confirmada en la lista` : `@${usuario} vuelve a la lista`;
  }
  if (accion === 'descartar') {
    await anaApi(`/api/figuras/${u}/descartar`, { method: 'POST' });
    return `Sugerencia descartada: @${usuario} no vuelve a sugerirse`;
  }
  if (accion === 'quitar') {
    await anaApi(`/api/figuras/${u}`, { method: 'DELETE' });
    return `@${usuario} salió de la lista`;
  }
  return '';
}

// ---------------------------------------------------------------- la tarjeta

function anaRenderPeople(v) {
  const lista = v.quienHablo;
  const ver = lista.filter((q) => q.verificada).length;
  const enLista = lista.filter((q) => q.figura && q.figura.origen === 'equipo').length;
  anaF.hint.textContent = lista.length
    ? `${anaPlural(ver, 'verificado', 'verificados')}${enLista ? ` · ${formatCount(enLista)} en la lista de figuras` : ''} · ordenados por likes`
    : 'ninguno en esta publicación';
  const conFoco = anaF.people.contains(document.activeElement) ? document.activeElement : null;
  const focoClave = conFoco && conFoco.closest('[data-u]') ? `${conFoco.closest('[data-u]').dataset.u}|${conFoco.dataset.k || ''}` : null;
  if (!lista.length) {
    anaF.people.replaceChildren(anaEl('div', 'empty', 'Ningún verificado ni figura pública comentó esta publicación.'));
    return;
  }
  anaF.people.replaceChildren(...lista.map(anaPersona));
  if (focoClave) {
    const [u, k] = focoClave.split('|');
    const fila = anaF.people.querySelector(`[data-u="${CSS.escape(u)}"]`);
    const target = fila && (k ? fila.querySelector(`[data-k="${k}"]`) : null);
    if (target) target.focus();
    else if (fila) (fila.querySelector('.who') || fila).focus();
  }
}

function anaPersona(q, i) {
  const f = q.figura;
  const u = String(q.usuario);
  const clave = u.toLowerCase();
  const elegido = Boolean(anaCmtSel && anaCmtSel.tipo === 'persona' && anaCmtSel.usuario === clave);
  const row = anaEl('div', `an-person${elegido ? ' on' : ''}`);
  row.dataset.u = clave;
  if (i < 8) row.style.animationDelay = `${i * 80}ms`;
  const av = anaEl('span', 'av', anaInitials((f && f.nombre) || u));
  av.style.setProperty('--col', accountColor(u));
  av.setAttribute('aria-hidden', 'true');
  if (q.verificada) av.append(anaEl('span', 'vf', '✓'));

  const body = anaEl('div');
  const nm = anaEl('div', 'nm');
  const who = anaEl('button', 'who', f && f.nombre ? f.nombre : `@${u}`);
  who.type = 'button';
  who.dataset.k = 'who';
  who.setAttribute('aria-pressed', String(elegido));
  who.dataset.tip = elegido ? 'Un clic: todos los comentarios otra vez' : 'Un clic: sus comentarios, abajo';
  nm.append(who);
  if (f && f.nombre) nm.append(anaEl('small', '', `@${u}`));
  if (q.verificada) nm.append(anaEl('span', 'sr', '(verificada)'));
  if (f) nm.append(anaRolChip(f, { sugerida: f.origen === 'sugerida' }));
  else if (q.descartada) nm.append(anaEl('span', 'an-rl', 'sugerencia descartada'));
  body.append(nm);
  if (q.comentario && q.comentario.texto) body.append(anaEl('div', 'tx', q.comentario.texto));

  // Las acciones sobre la lista de figuras.
  const acts = anaEl('div', 'acts');
  const accion = (texto, k, fn, clase) => {
    const b = anaBtn(texto, clase);
    b.dataset.k = k;
    b.addEventListener('click', fn);
    acts.append(b);
    return b;
  };
  const editar = () => {
    anaFigEditando = clave;
    anaFigQuitando = null;
    anaRenderPeople(anaVista());
  };
  const correr = (nombre) => async () => {
    try {
      const m = await anaFigAccion(u, nombre);
      anaFigQuitando = null;
      await anaFigDespues(m);
    } catch (err) {
      anaToast(err.message);
    }
  };
  if (anaFigQuitando === clave) {
    acts.append(anaEl('span', 'note', `¿Quitar a @${u} de la lista?`));
    accion('Sí, quitar', 'si', correr('quitar'), 'btn sm');
    accion('No', 'no', () => {
      anaFigQuitando = null;
      anaRenderPeople(anaVista());
    }, 'btn sm ghost');
  } else if (f && f.origen === 'sugerida') {
    accion('Confirmar', 'confirmar', correr('confirmar'), 'btn sm');
    accion('Editar', 'editar', editar, 'btn sm ghost');
    accion('Descartar', 'descartar', correr('descartar'), 'btn sm ghost');
  } else if (f) {
    accion('Editar', 'editar', editar, 'btn sm ghost');
    accion('Quitar de la lista', 'quitar', () => {
      anaFigQuitando = clave;
      anaFigEditando = null;
      anaRenderPeople(anaVista());
    }, 'btn sm ghost');
  } else if (q.verificada) {
    accion('Agregar a la lista', 'agregar', editar, 'btn sm ghost');
  }
  if (acts.children.length && anaFigEditando !== clave) body.append(acts);

  const c = q.comentario || {};
  const tono = ANA_TONO[c.tono] || ANA_SIN_CLASIFICAR;
  const st = anaEl('div', 'st');
  st.append(anaEl('span', '', c.likes === null || c.likes === undefined ? '♥ —' : `♥ ${formatCount(c.likes)}`));
  const t = anaEl('span', '', tono.label);
  const punto = anaEl('i', tono.bar);
  punto.setAttribute('aria-hidden', 'true');
  t.prepend(punto);
  st.append(t);
  const hh = anaHh(c.horas);
  if (hh) st.append(anaEl('span', '', hh));
  row.append(av, body, st);

  if (anaFigEditando === clave) {
    const enTabla = anaFigDe(clave) || (f ? { username: clave, ...f } : null);
    row.append(
      anaFigForm({
        figura: enTabla,
        usuario: clave,
        onDone: async () => {
          anaFigEditando = null;
          await anaFigDespues('Figura guardada');
        },
        onCancel: () => {
          anaFigEditando = null;
          anaRenderPeople(anaVista());
          const fila = anaF.people.querySelector(`[data-u="${CSS.escape(clave)}"]`);
          if (fila) (fila.querySelector('[data-k="editar"], [data-k="agregar"]') || fila.querySelector('.who')).focus();
        },
      })
    );
  }
  return row;
}

anaF.people.addEventListener('click', (e) => {
  const who = e.target.closest('.who');
  if (who && anaShown) anaFiltrarPersona(who.closest('[data-u]').dataset.u);
});

// ---------------------------------------------------------------- la lista (diálogo)

const ANA_FIG_GRUPOS = [
  ['equipo', 'Del equipo'],
  ['sugerida', 'Sugeridas por el modelo'],
  ['descartada', 'Descartadas'],
];

function anaFigRenderDlg() {
  const q = anaPlegar(anaF.q.value.trim().replace(/^@+/, ''));
  const filtradas = anaFigLista.filter((f) => !q || anaPlegar(`${f.username} ${f.nombre || ''}`).includes(q));
  const partes = [];
  for (const [origen, titulo] of ANA_FIG_GRUPOS) {
    const grupo = filtradas.filter((f) => f.origen === origen);
    if (!grupo.length) continue;
    partes.push(anaEl('h3', '', `${titulo} · ${formatCount(grupo.length)}`));
    for (const f of grupo) partes.push(anaFigFila(f));
  }
  if (!partes.length) partes.push(anaEl('div', 'empty', q ? 'Nadie en la lista coincide con esa búsqueda.' : 'La lista está vacía. Agregá la primera figura.'));
  anaF.list.replaceChildren(...partes);
}

function anaFigFila(f) {
  const row = anaEl('div', 'an-fig-row');
  row.dataset.u = f.username;
  const nm = anaEl('div', 'nm');
  nm.append(anaEl('b', '', f.nombre || `@${f.username}`));
  if (f.nombre) nm.append(anaEl('small', '', `@${f.username}`));
  nm.append(anaRolChip(f, { sugerida: f.origen === 'sugerida' }));
  const acts = anaEl('div', 'acts');
  const accion = (texto, fn, clase = 'btn sm ghost') => {
    const b = anaBtn(texto, clase);
    b.addEventListener('click', fn);
    acts.append(b);
  };
  const correr = (nombre) => async () => {
    try {
      anaF.msg.textContent = await anaFigAccion(f.username, nombre);
      anaFigCambio = true;
      anaFigDlgQuitando = null;
      await anaFigCargar();
      anaFigRenderDlg();
    } catch (err) {
      anaF.msg.textContent = err.message;
    }
  };
  const editar = () => {
    anaFigDlgEditando = f.username;
    anaFigDlgQuitando = null;
    anaFigRenderDlg();
  };
  if (anaFigDlgQuitando === f.username) {
    acts.append(anaEl('span', 'note', '¿Quitarla de la lista?'));
    accion('Sí, quitar', correr('quitar'), 'btn sm');
    accion('No', () => {
      anaFigDlgQuitando = null;
      anaFigRenderDlg();
    });
  } else {
    if (f.origen === 'sugerida') {
      accion('Confirmar', correr('confirmar'), 'btn sm');
      accion('Editar', editar);
      accion('Descartar', correr('descartar'));
    } else if (f.origen === 'descartada') {
      accion('Restaurar', correr('restaurar'), 'btn sm');
      accion('Editar', editar);
    } else {
      accion('Editar', editar);
    }
    accion('Quitar', () => {
      anaFigDlgQuitando = f.username;
      anaFigDlgEditando = null;
      anaFigRenderDlg();
    });
  }
  row.append(nm, acts);
  if (anaFigDlgEditando === f.username) {
    row.append(
      anaFigForm({
        figura: f,
        usuario: f.username,
        onDone: async () => {
          anaFigDlgEditando = null;
          anaFigCambio = true;
          await anaFigCargar();
          anaF.msg.textContent = `@${f.username} guardada.`;
          anaFigRenderDlg();
        },
        onCancel: () => {
          anaFigDlgEditando = null;
          anaFigRenderDlg();
        },
      })
    );
  }
  return row;
}

anaF.open.addEventListener('click', async () => {
  anaFigOpener = anaF.open;
  anaFigCambio = false;
  anaFigCerrado = false;
  anaFigDlgEditando = null;
  anaFigDlgQuitando = null;
  anaF.msg.textContent = '';
  anaF.formBox.replaceChildren();
  anaF.list.replaceChildren(anaEl('div', 'empty', 'Cargando la lista…'));
  if (typeof anaF.dlg.showModal === 'function') anaF.dlg.showModal();
  else anaF.dlg.setAttribute('open', '');
  anaF.q.focus();
  try {
    await anaFigCargar();
    anaFigRenderDlg();
  } catch (err) {
    anaF.list.replaceChildren(anaEl('div', 'empty', err.message));
  }
});

anaF.add.addEventListener('click', () => {
  anaF.msg.textContent = '';
  anaF.formBox.replaceChildren(
    anaFigForm({
      figura: null,
      conUsuario: true,
      onDone: async (u) => {
        anaFigCambio = true;
        anaF.formBox.replaceChildren();
        await anaFigCargar();
        anaF.msg.textContent = `@${String(u).toLowerCase()} está en la lista.`;
        anaFigRenderDlg();
        anaF.add.focus();
      },
      onCancel: () => {
        anaF.formBox.replaceChildren();
        anaF.add.focus();
      },
    })
  );
});

anaF.q.addEventListener('input', () => anaFigRenderDlg());

// Al cerrar (✕, Escape o el evento close, el que llegue primero; no todos
// los navegadores mandan close): el foco vuelve a quien lo abrió y, si algo
// cambió, se vuelve a leer el análisis a la vista.
let anaFigCerrado = true;
async function anaFigAlCerrar() {
  if (anaFigCerrado) return;
  anaFigCerrado = true;
  if (anaFigOpener) anaFigOpener.focus();
  if (anaFigCambio && anaShown) {
    anaFigCambio = false;
    await anaFigDespues('');
  }
}
anaF.close.addEventListener('click', () => {
  anaF.dlg.close();
  anaFigAlCerrar();
});
anaF.dlg.addEventListener('cancel', () => setTimeout(anaFigAlCerrar, 0));
anaF.dlg.addEventListener('close', anaFigAlCerrar);
anaF.dlg.addEventListener('keydown', (e) => {
  // Escape dentro de un formulario lo cierra a él (preventDefault), no a la lista.
  if (e.key === 'Escape' && !e.defaultPrevented) setTimeout(() => !anaF.dlg.open && anaFigAlCerrar(), 0);
});

// El catálogo de roles (y la lista, para saber quién está) al cargar: la
// tarjeta nombra los roles con su texto.
anaFigCargar()
  .then(() => {
    if (anaShown) anaRenderPeople(anaShown.vista);
  })
  .catch(() => {});
