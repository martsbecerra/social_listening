// Editor de temas emergentes del análisis. Copiar/WhatsApp reconstruyen el
// reporte; el resto del texto (before/after) no se edita. No persiste.
(function (global) {
  const MAX = 8;
  const HEADING = '🗣️ TEMAS DE LA CONVERSACIÓN';

  function trimTema(item) {
    const titulo = String(item && item.titulo != null ? item.titulo : '').trim();
    const texto = String(item && item.texto != null ? item.texto : '').trim();
    return { titulo, texto };
  }

  function filled(temas) {
    return (temas || []).map(trimTema).filter((t) => t.titulo && t.texto);
  }

  function formatSection(temas) {
    const list = filled(temas);
    if (list.length === 0) return '';
    const body = list.map((t, i) => (i + 1) + '. ' + t.titulo + ': ' + t.texto).join('\n\n');
    return HEADING + '\n\n' + body;
  }

  function assemble(beforeTemas, temas, afterTemas) {
    const section = formatSection(temas);
    const before = String(beforeTemas || '').replace(/\s+$/, '');
    const after = String(afterTemas || '').replace(/^\s+/, '');
    if (!section) return before + '\n\n' + after;
    return before + '\n\n' + section + '\n\n' + after;
  }

  function mount(opts) {
    const listEl = opts.listEl;
    const addBtn = opts.addBtn;
    const onChange = opts.onChange || function () {};
    let temas = [];

    function emit() {
      onChange(getTemas());
    }

    function getTemas() {
      return temas.map(trimTema);
    }

    function render() {
      listEl.innerHTML = '';
      temas.forEach((tema, index) => {
        const row = document.createElement('div');
        row.className = 'tema-row';

        const titleLabel = document.createElement('label');
        titleLabel.className = 'tag';
        titleLabel.textContent = 'Título';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.value = tema.titulo;
        titleInput.placeholder = 'Ej. Uso excesivo del celular';
        titleInput.addEventListener('input', () => {
          temas[index].titulo = titleInput.value;
          emit();
        });

        const textLabel = document.createElement('label');
        textLabel.className = 'tag';
        textLabel.textContent = 'Texto';
        const textArea = document.createElement('textarea');
        textArea.rows = 3;
        textArea.value = tema.texto;
        textArea.placeholder = '1 o 2 oraciones que agrupen el reclamo o apoyo recurrente.';
        textArea.addEventListener('input', () => {
          temas[index].texto = textArea.value;
          emit();
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-small btn-clear';
        removeBtn.textContent = 'Quitar';
        removeBtn.addEventListener('click', () => {
          temas.splice(index, 1);
          render();
          emit();
        });

        row.appendChild(titleLabel);
        row.appendChild(titleInput);
        row.appendChild(textLabel);
        row.appendChild(textArea);
        row.appendChild(removeBtn);
        listEl.appendChild(row);
      });

      if (addBtn) {
        addBtn.disabled = temas.length >= MAX;
      }
    }

    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (temas.length >= MAX) return;
        temas.push({ titulo: '', texto: '' });
        render();
        emit();
      });
    }

    return {
      setTemas(next) {
        const incoming = Array.isArray(next) ? next.map(trimTema) : [];
        temas = incoming.length > 0 ? incoming.slice(0, MAX) : [];
        render();
      },
      getTemas,
      assembleWith(beforeTemas, afterTemas) {
        return assemble(beforeTemas, getTemas(), afterTemas);
      },
    };
  }

  global.TemasConversacion = { MAX, HEADING, formatSection, assemble, mount };
})(window);
