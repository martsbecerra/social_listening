# Réplicas de solo lectura: instalación y configuración

Guía paso a paso para poner en marcha las réplicas. Qué son y cómo
funcionan: [README.md](README.md).

Hay tres partes, en este orden:

1. [Antes de empezar](#1-antes-de-empezar): dos comprobaciones.
2. [GitHub y la PC principal](#2-github-y-la-pc-principal): se hace una
   sola vez.
3. [Cada máquina nueva](#3-cada-máquina-nueva): se repite por persona.

Al final: [mantenimiento](#4-mantenimiento) y
[problemas frecuentes](#5-problemas-frecuentes).

Ningún paso necesita permisos de administrador en las máquinas de la red.

---

## 1. Antes de empezar

### 1.1 GitHub responde desde la red de la organización

Desde una máquina de esa red, en PowerShell:

```powershell
Test-NetConnection github.com -Port 443
```

`TcpTestSucceeded : True` alcanza para seguir. Si da `False`, la red bloquea
GitHub y este esquema no sirve tal cual: hay que pedir que habiliten
`github.com` y `codeload.github.com`, o elegir otro lugar para el snapshot.

Para estar seguro del todo, repetir esta prueba después del paso 2.3, ya con
el token de lectura (ver [3.4](#34-comprobar)).

### 1.2 El tamaño de la base

GitHub rechaza archivos de más de 100 MB. En la PC principal, con la app
corriendo o no:

```powershell
"{0:N1} MB" -f ((Get-Item data\monitoring.db).Length / 1MB)
"{0:N1} MB de fotos" -f ((Get-ChildItem -Recurse -File data\media | Measure-Object Length -Sum).Sum / 1MB)
```

Esto solo lee el tamaño de los archivos: no abre la base.

- Base de menos de 50 MB: sin problema.
- Entre 50 y 100 MB: anda, con un aviso de GitHub en cada publicación. Hay
  que pensar cómo achicarla antes de que llegue al tope.
- Más de 100 MB: la publicación falla. Avisar antes de seguir.

Las fotos no tienen ese problema (cada una pesa unos KB y se suben solo las
nuevas), pero suman al tamaño del repo: GitHub recomienda no pasar de 1 GB.

---

## 2. GitHub y la PC principal

Lo hace el dueño, una sola vez.

### 2.1 Crear el repo de datos

1. En GitHub: **New repository**.
2. Nombre, por ejemplo `social-listening-datos`.
3. **Private**. Importante: tiene la base completa del monitoreo.
4. Sin README, sin `.gitignore`, sin licencia: tiene que quedar vacío.
5. **Create repository** y copiar la URL https
   (`https://github.com/<dueño>/social-listening-datos.git`).

Es un repo distinto del de la app. No subir nada a mano: la rama `snapshot`
la crea la app en la primera publicación.

### 2.2 Clonar el repo en la PC principal

En la PC principal, en una carpeta **fuera** del repo de la app (un repo
adentro de otro confunde a git):

```powershell
cd $HOME
git clone https://github.com/<dueño>/social-listening-datos.git sl-datos
```

Si GitHub pide iniciar sesión, elegir **Sign in with your browser** y entrar
con la cuenta dueña del repo. El administrador de credenciales de Git para
Windows guarda ese permiso, y es el que va a usar la app para subir cada
snapshot.

Git va a avisar `You appear to have cloned an empty repository`: es lo
esperado.

Si se prefiere no usar la cuenta personal, se puede crear un token
fine-grained con permiso **Contents: Read and write** sobre solo este repo
(mismos pasos que en 2.3) y pegarlo cuando git pida la contraseña.

### 2.3 Crear el token de lectura para las réplicas

En GitHub: foto de perfil > **Settings** > **Developer settings** >
**Personal access tokens** > **Fine-grained tokens** > **Generate new token**.

| Campo | Valor |
|---|---|
| Token name | `social-listening-replicas` |
| Expiration | La que permita la organización (por ejemplo, 1 año). Anotar la fecha: ver [4.3](#43-renovar-el-token-de-lectura) |
| Resource owner | El dueño del repo de datos |
| Repository access | **Only select repositories** > `social-listening-datos` |
| Permissions > Repository permissions > Contents | **Read-only** |

Ningún otro permiso (Metadata queda en Read-only solo, es obligatorio).

**Generate token** y guardarlo en un lugar seguro (un gestor de
contraseñas): GitHub no lo vuelve a mostrar. Ese token es el que se le pasa
a cada persona en el paso 3.3. No mandarlo por un canal público ni dejarlo
en un documento compartido.

Si el repo es de una organización, puede que un admin tenga que aprobar el
token antes de que funcione.

### 2.4 Configurar la PC principal

En el `.env` de la app (el de la PC principal), agregar:

```
REPLICA_PUBLISH_DIR=C:\Users\<usuario>\sl-datos
```

con la ruta de la carpeta del paso 2.2. Reiniciar la app.

### 2.5 Primera publicación

La app publica al terminar cada ciclo: el automático (8, 12, 16 y 20 h) o
uno a mano con **Actualizar ahora**. Cuidado: "Actualizar ahora" corre un
ciclo real y gasta en Apify.

En la consola de la app, al final del ciclo, tiene que aparecer:

```
[réplica] snapshot publicado (ciclo #N, X foto(s) nueva(s), 0 borrada(s), Ys)
```

Y en GitHub, el repo de datos tiene que mostrar la rama `snapshot` con un
solo commit y los archivos `monitoring.db`, `snapshot.json`, `config/` y
`media/`.

Si en cambio aparece `[réplica] no se pudo publicar: ...`, ver
[problemas frecuentes](#5-problemas-frecuentes). El ciclo de monitoreo no se
ve afectado: solo no hubo publicación.

### 2.6 Armar el instalador

En la PC donde está el repo de la app (puede ser la principal), con todo
commiteado:

```powershell
powershell -ExecutionPolicy Bypass -File installer\armar-instalador.ps1 `
  -RepoUrl https://github.com/<dueño>/social-listening-datos.git
```

Tarda unos minutos y necesita internet: baja Node y MinGit portables (las
descargas quedan en `dist\descargas\` y se reusan) y las dependencias de la
app. Termina con:

```
Listo: ...\dist\SocialListening-replica.zip (95 MB, commit abc1234)
```

Parámetros opcionales:

| Parámetro | Default | Para qué |
|---|---|---|
| `-Port` | `3000` | Puerto de la app en cada máquina. Cambiarlo si 3000 está ocupado en las máquinas de la red |
| `-NodeVersion` | `24.14.0` | Versión de Node portable (mínimo 22.5) |
| `-MinGitVersion` | `2.53.0` | Versión de MinGit portable |

El zip lleva el último commit, no lo que haya sin commitear (lo avisa). No
lleva ningún secreto: se puede repartir por mail, por una carpeta compartida
o por un pendrive.

---

## 3. Cada máquina nueva

Lo hace cada persona, o alguien con la persona al lado. Se necesita el zip
del paso 2.6 y el token de lectura del paso 2.3.

Requisitos: Windows 10 u 11 de 64 bits, unos 400 MB libres más lo que pesen
los datos, y acceso a `github.com`.

### 3.1 Descomprimir

Clic derecho en `SocialListening-replica.zip` > **Extraer todo** > en
cualquier carpeta (por ejemplo, Descargas). Esa carpeta es solo el
instalador: después se puede borrar.

### 3.2 Correr el instalador

En la carpeta descomprimida: clic derecho en `instalar.ps1` > **Ejecutar con
PowerShell**.

Si Windows no deja correrlo (política de ejecución), abrir PowerShell en esa
carpeta y correr:

```powershell
powershell -ExecutionPolicy Bypass -File .\instalar.ps1
```

El instalador:

1. copia la app a `%LOCALAPPDATA%\SocialListening`;
2. pide el token (paso 3.3);
3. crea el acceso directo **Social Listening** en el escritorio;
4. crea el arranque automático al iniciar sesión;
5. arranca la copia, espera que baje los datos y abre el navegador.

### 3.3 Pegar el token

Cuando aparece `Token:`, pegar el token de lectura (clic derecho pega en la
consola) y apretar Enter. No se ve mientras se escribe: es normal.

Queda guardado solo en `%LOCALAPPDATA%\SocialListening\.env`, en esa
máquina.

Si todavía no se tiene el token, apretar Enter sin nada: la copia se
instala igual pero sin datos. Para cargarlo después, volver a correr
`instalar.ps1`.

### 3.4 Comprobar

Se abre el navegador en `http://localhost:3000/dashboard.html`. Tiene que
verse:

- arriba, la franja amarilla **Copia de solo lectura · Datos al DD/MM
  HH:MM**, con la fecha del último ciclo de la PC principal;
- los posteos en Monitoreo en vivo.

Si la franja dice **Todavía no hay datos descargados**, la copia no pudo
bajar el snapshot. Ver [problemas frecuentes](#5-problemas-frecuentes).

### 3.5 Uso diario

- La copia arranca sola al iniciar sesión en Windows: una ventana minimizada
  en la barra de tareas, "Social Listening (copia de solo lectura)". **No
  cerrarla**: es la app.
- Para entrar, el acceso directo **Social Listening** del escritorio.
- Los datos nuevos llegan solos, hasta 10 minutos después de cada ciclo de
  la PC principal. No hace falta hacer nada.

---

## 4. Mantenimiento

### 4.1 Actualizar la app en las máquinas

Cuando cambia el código de la app, las réplicas muestran "Hay una versión
nueva de la app: pedí el instalador actualizado" (lo detectan porque el
snapshot dice con qué versión se publicó).

1. Armar el zip de nuevo (paso 2.6).
2. En cada máquina, descomprimirlo y correr `instalar.ps1` (pasos 3.1 y
   3.2).

El instalador para la copia que está corriendo, copia la versión nueva y
conserva el token, los datos y los logs. No vuelve a pedir el token.

Una réplica con el código viejo sigue andando mientras tanto, salvo que el
cambio haya tocado la estructura de la base.

### 4.2 Cambiar el token de una réplica

Por ejemplo, si venció o se revocó:

1. Abrir `%LOCALAPPDATA%\SocialListening\.env` con el Bloc de notas.
2. Dejar la línea así, sin nada después del `=`: `DATA_REPO_TOKEN=`.
3. Guardar y correr `instalar.ps1` de nuevo: pide el token.

O directamente reemplazar el valor en esa línea y reiniciar la sesión de
Windows.

### 4.3 Renovar el token de lectura

Un token fine-grained vence. Antes de la fecha: en GitHub, el token >
**Regenerate token** y cargarlo en cada máquina (4.2). Si vence sin
renovarse, las réplicas siguen mostrando los últimos datos que bajaron y no
se actualizan más.

Si el token se filtra: en GitHub, **Delete** sobre el token, crear uno nuevo
(2.3) y cargarlo en cada máquina.

### 4.4 Desinstalar una réplica

1. Cerrar la ventana "Social Listening (copia de solo lectura)".
2. Borrar la carpeta `%LOCALAPPDATA%\SocialListening`.
3. Borrar el acceso directo del escritorio y
   `Social Listening (copia).lnk` de la carpeta de inicio (Win+R >
   `shell:startup`).

### 4.5 Dejar de publicar

En el `.env` de la PC principal, dejar `REPLICA_PUBLISH_DIR=` vacío y
reiniciar la app. Las réplicas se quedan con los últimos datos.

---

## 5. Problemas frecuentes

Los logs de una réplica están en `%LOCALAPPDATA%\SocialListening\logs\`, un
archivo por arranque (`replica.<fecha>_<hora>.log`). Los de la PC principal,
en su consola o en `logs\` si se usa `scripts\iniciar-con-reinicio.bat`.

### En la PC principal

| Mensaje | Causa probable | Qué hacer |
|---|---|---|
| `no se pudo publicar: ... Authentication failed` o `could not read Username` | git no tiene credenciales guardadas | En la carpeta de `REPLICA_PUBLISH_DIR`, correr `git fetch` a mano e iniciar sesión (paso 2.2) |
| `no se pudo publicar: ... not a git repository` | `REPLICA_PUBLISH_DIR` no apunta al clon | Revisar la ruta en el `.env` |
| `no se pudo publicar: ... exceeds GitHub's file size limit` | La base pasa los 100 MB | Ver 1.2 |
| No aparece ninguna línea `[réplica]` | `REPLICA_PUBLISH_DIR` vacío, o la app no se reinició | Revisar el `.env` y reiniciar |

### En una réplica

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| "Todavía no hay datos descargados" y en el log `no se pudo traer el snapshot` | Sin token, token vencido o sin acceso a GitHub | Revisar el token (4.2) y la red (1.1) |
| Lo mismo, con `Remote branch snapshot not found` | La PC principal todavía no publicó | Esperar al próximo ciclo (2.5) |
| `falta REPLICA_REPO_URL` | El `.env` perdió la URL | Correr `instalar.ps1` de nuevo |
| El acceso directo abre una página que no carga | La ventana de la copia está cerrada | Cerrar sesión y volver a entrar, o correr `instalar.ps1` |
| La app arranca y se cierra en loop, con `EADDRINUSE` | Otro programa usa el puerto 3000 | Armar el zip con otro `-Port` (2.6) y reinstalar |
| La tabla o el mapa no aparecen, el resto sí | La red bloquea las CDN de Tabulator o Leaflet | Pedir que las habiliten; ver "Límites conocidos" en [README.md](README.md) |
| "la base descargada está dañada" | Descarga cortada | Se arregla sola en la próxima publicación; mientras, se ve la base anterior |
| Los datos no se actualizan aunque hubo ciclos | Token vencido, o la PC principal no publica | Revisar el log de la réplica y la línea `[réplica]` de la principal |

En el log de una réplica sana, cada arranque se ve así:

```
[réplica] snapshot traído del repo de datos.
[réplica] datos aplicados (N foto(s) nueva(s), 0 borrada(s)).
✅ Servidor listo en http://localhost:3000
   Modo: réplica de solo lectura (APP_MODE=replica). Sin monitoreo, sin login, solo esta máquina.
```
