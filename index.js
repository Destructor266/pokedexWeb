const API_BASE_URL = "https://pokeapi.co/api/v2";
const listaPokemons = document.getElementById("listaPokemons");
const numeroPaginasPorRegistro = 20;
// Distancia al final de la lista (en px) a partir de la cual se pide la siguiente página
const margenCarga = 100;
// IndexedDB se usa como caché del detalle de cada pokémon: lo que ya está guardado
// no se vuelve a pedir a la API. El "store" es el equivalente a una tabla.
const nombreStore = "pkmns";
// La BD se abre una sola vez al cargar el script. dbPkmnDex es una Promise que se
// resuelve con la base de datos ya abierta; quien la necesite hace `await dbPkmnDex`
const dbPkmnDex = abrirPkmnDb();

let numeroPaginasActual = 0;
let cargando = false;
let hayMasPokemons = true;

// La API de IndexedDB funciona con eventos (onsuccess, onerror...), no con Promises.
// Envolverla en una Promise permite usarla con async/await como el resto del código.
function abrirPkmnDb() {
  return new Promise((resolve, reject) => {
    // open() no devuelve la BD sino una petición; la BD llega después en peticion.result.
    // Versión 4: la 3 quedó creada sin object store, así que hay que forzar otro upgrade
    const peticion = window.indexedDB.open("pkmnDex", 4);

    // Salta cuando la BD no existe o su versión es menor que la pedida. Debe asignarse
    // junto al open(); es el único momento en que se pueden crear stores e índices
    peticion.onupgradeneeded = () => {
      const db = peticion.result;
      if (!db.objectStoreNames.contains(nombreStore)) {
        // Cada pokémon se guarda con su id como clave primaria...
        const pkmnTable = db.createObjectStore(nombreStore, { keyPath: "id" });
        // ...y con un índice por nombre, que es lo que se usa para buscarlo en la caché
        pkmnTable.createIndex("name", "name", { unique: true });
      }
    };
    // Cuando termina de abrir (y de actualizar, si hacía falta) se entrega la BD
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => {
      console.error("Why didn't you allow my web app to use IndexedDB?!");
      reject(peticion.error);
    };
  });
}

// Guarda en la caché una lista de pokémon descargados de la API.
async function actualizarPkmn(pkmnData) {
  const db = await dbPkmnDex;
  return new Promise((resolve, reject) => {
    // Todo se escribe en una única transacción: o se guardan todos o ninguno
    const transaccion = db.transaction(nombreStore, "readwrite");
    const pkmnObjectStore = transaccion.objectStore(nombreStore);
    // Solo llegan pokémon que no estaban en la caché, pero se usa put en lugar de add
    // por si otra pestaña lo ha guardado entretanto; add fallaría por clave repetida
    pkmnData.forEach((pkmn) => pkmnObjectStore.put(pkmn));
    // Los datos no están garantizados en disco hasta que la transacción se completa
    transaccion.oncomplete = () => resolve();
    transaccion.onerror = () => {
      console.log("Something went wrong when saving into database");
      reject(transaccion.error);
    };
  });
}

// Busca un pokémon en la caché por su nombre.
// Devuelve el objeto guardado, o undefined si todavía no está en la caché.
async function obtenerPkmn(pkmnName) {
  const db = await dbPkmnDex;
  return new Promise((resolve, reject) => {
    // Sin indicar modo, la transacción es de solo lectura (readonly).
    // La clave del store es el id, así que para buscar por nombre se usa el índice
    const peticion = db
      .transaction(nombreStore)
      .objectStore(nombreStore)
      .index("name")
      .get(pkmnName);
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => {
      console.log("Something went wrong when retrieving data from database");
      reject(peticion.error);
    };
  });
}

async function obtenerJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Error ${response.status} en ${url}`);
  return response.json();
}

async function pokeDex() {
  // Evita pedir la misma página dos veces mientras la anterior aún no ha llegado
  if (cargando || !hayMasPokemons) return;
  cargando = true;
  const queryPrincipal = `${API_BASE_URL}/pokemon/?limit=${numeroPaginasPorRegistro}&offset=${numeroPaginasActual}`;
  let cargadoBien = false;
  try {
    const pokemonsResults = await obtenerJSON(queryPrincipal);
    await anadirPokemonsPantalla(pokemonsResults);
    // Solo se avanza si la página ha llegado bien, para no saltarse ninguna
    numeroPaginasActual += numeroPaginasPorRegistro;
    hayMasPokemons = pokemonsResults.next !== null;
    cargadoBien = true;
  } catch (error) {
    console.error("No se pudieron cargar los pokémon:", error);
  } finally {
    cargando = false;
  }

  // Si la lista aún no llena la pantalla no habrá scroll, así que se sigue cargando
  if (cargadoBien && cercaDelFinal()) pokeDex();
}

function cercaDelFinal() {
  const { scrollTop, clientHeight, scrollHeight } = listaPokemons;
  return scrollTop + clientHeight >= scrollHeight - margenCarga;
}

async function anadirPokemonsPantalla(pokemonsResults) {
  // pokemonsResults.results solo trae { name, url } de cada pokémon de la página.
  // Con el nombre basta para saber si ya lo tenemos en la caché.

  // 1. Buscar en IndexedDB todos los pokémon de la página a la vez.
  //    obtenerPkmn devuelve undefined para los que todavía no se han guardado.
  const enCache = await Promise.all(
    pokemonsResults.results.map((pokemonResult) =>
      obtenerPkmn(pokemonResult.name),
    ),
  );

  // 2. Quedarse solo con los que no estaban y pedir su detalle a la API.
  //    Las peticiones salen en paralelo, pero Promise.all respeta el orden original
  const faltan = pokemonsResults.results.filter(
    (_, indice) => enCache[indice] === undefined,
  );
  const descargados = await Promise.all(
    faltan.map((pokemonResult) => obtenerJSON(pokemonResult.url)),
  );

  // 3. Guardar en la caché únicamente los nuevos, para que la próxima vez
  //    ya no haga falta pedirlos. Si no falta ninguno no se abre transacción.
  if (descargados.length > 0) await actualizarPkmn(descargados);

  // 4. Juntar los de la caché con los descargados en el orden de la página:
  //    donde la caché devolvió undefined se pone el que acaba de llegar de la API.
  const descargadosPorNombre = new Map(
    descargados.map((pokemon) => [pokemon.name, pokemon]),
  );
  const pokemons = pokemonsResults.results.map(
    (pokemonResult, indice) =>
      enCache[indice] ?? descargadosPorNombre.get(pokemonResult.name),
  );

  console.log(
    `Página cargada: ${pokemons.length - descargados.length} desde caché, ${descargados.length} desde la API`,
  );
  pokemons.forEach((pokemon) => crearEstructuraLista(pokemon.name));
}

function crearEstructuraLista(strNombrePokemon) {
  const registroPokemon = document.createElement("div");
  const nombrePokemon = document.createElement("p");
  registroPokemon.classList = "registroPokemon";
  nombrePokemon.classList = "nombrePokemon";
  nombrePokemon.innerHTML = strNombrePokemon;
  registroPokemon.appendChild(nombrePokemon);
  listaPokemons.appendChild(registroPokemon);
}

listaPokemons.addEventListener("scroll", () => {
  if (cercaDelFinal()) pokeDex();
});

pokeDex();
