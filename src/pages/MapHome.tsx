import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { RepeatDraft } from '@/lib/repeatPlan';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { Plus, LocateFixed, Layers, List, Map as MapIcon, Search, SlidersHorizontal, X as XIcon, type LucideIcon } from 'lucide-react';
import { useEventStore, selectSelectedEvent } from '@/stores/eventStore';
import { EVENT_CATEGORIES, MAPBOX_STYLE_LIGHT, MAPBOX_STYLE_DARK } from '@/lib/constants';
import { prefersDark, onColorSchemeChange } from '@/lib/theme';
import { CATEGORY_ICONS, getCategoryMarkerSVG } from '@/lib/categoryIcons';
import { EventListView } from '@/components/map/EventListView';
import { cn } from '@/lib/utils';
import { EventBottomSheet } from '@/components/map/EventBottomSheet';
import { CreateEventSheet } from '@/components/map/CreateEventSheet';
import { LocationPickerOverlay } from '@/components/map/LocationPickerOverlay';
import { WelcomeTour } from '@/components/map/WelcomeTour';
import { supabase } from '@/integrations/supabase/client';
import { useUserLocation } from '@/hooks/useUserLocation';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/hooks/use-toast';
import i18n from '@/i18n';
import mapboxgl, { type Map as MapboxMap, type Marker as MapboxMarker } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { pageTitle } from '@/lib/brand';
import { useInstitutionCenter } from '@/hooks/useInstitutionCenter';
import { toMapEvent, needsServerCheck, type EventRow } from '@/lib/eventSync';
import { matchesFilter, filterEvents, countActiveFilters, dependsOnClock } from '@/lib/eventFilter';
import { EventFiltersSheet } from '@/components/map/EventFiltersSheet';
import { ActiveFilterChips } from '@/components/map/ActiveFilterChips';
import { planMarkers, CLUSTER_MAX_ZOOM, MAX_MAP_EVENTS } from '@/lib/mapClusters';

/** Un marcador vivo, con lo justo para saber qué hay que refrescar de él. */
type MarkerEntry = {
  marker: MapboxMarker;
  /** El hijo que lleva el color y el icono; a la raíz la posiciona Mapbox. */
  inner: HTMLDivElement;
  category: string;
  lng: number;
  lat: number;
  onMap: boolean;
};

/** Un racimo vivo: el marcador con el número y a dónde lleva al pulsarlo. */
type ClusterEntry = {
  marker: MapboxMarker;
  label: HTMLDivElement;
  count: number;
  /** Encuadre de sus miembros, para acercarse a ellos al pulsar. */
  bounds: [[number, number], [number, number]];
};

/**
 * Lo que hace falta del payload de tiempo real.
 *
 * Se declara aquí en vez de importarlo: supabase-js 2.100 no reexporta
 * RealtimePostgresChangesPayload, y tirar de @supabase/realtime-js sería
 * depender de un paquete que no está en package.json y solo llega como
 * dependencia transitiva.
 */
type EventChange =
  | { eventType: 'INSERT'; new: EventRow }
  | { eventType: 'UPDATE'; new: EventRow }
  | { eventType: 'DELETE'; old: Partial<EventRow> };

export default function MapHome() {
  const { t } = useTranslation();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  // Indexado por id de evento: es lo que permite reutilizar el marcador que ya
  // existe en vez de rehacerlo. `markersMapRef` guarda a qué instancia del mapa
  // pertenece el caché, para vaciarlo si el mapa se recreara.
  const markersRef = useRef<Map<string, MarkerEntry>>(new Map());
  const markersMapRef = useRef<MapboxMap | null>(null);
  const clustersRef = useRef<Map<string, ClusterEntry>>(new Map());
  const { events, setEvents, upsertEvent, removeEvent, setSelectedEvent, filterCategory, setFilterCategory, advancedFilters, resetFilters } = useEventStore();
  const [filtersOpen, setFiltersOpen] = useState(false);
  // "Ahora" y "Próximas 3 h" caducan solos: sin este reloj, un evento que
  // terminó seguiría saliendo hasta tocar algo. Solo late con esos filtros.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!dependsOnClock(advancedFilters)) return;
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [advancedFilters]);
  const activeFilterCount = countActiveFilters(advancedFilters);
  // Resuelto contra la lista viva en cada render: así la hoja abierta refleja
  // lo que llegue por tiempo real.
  const selectedEvent = useEventStore(selectSelectedEvent);
  const [showCreate, setShowCreate] = useState(false);
  // "Repetir el plan" llega desde la ficha de un evento pasado (Mis eventos)
  // con el borrador en el state de la navegación.
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const [repeatDraft, setRepeatDraft] = useState<RepeatDraft | null>(null);
  // El aviso de primer uso. Se guarda en el perfil y no en localStorage para
  // que no reaparezca al cambiar de telefono.
  const { profile, fetchProfile } = useAuthStore();
  const [tipDismissed, setTipDismissed] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  // El centro sale de la institución del usuario, no de una constante.
  const { center: institutionCenter, resolved: centerResolved } = useInstitutionCenter();
  // Ref y no dependencia del efecto: ese efecto tiene una limpieza que destruye
  // el mapa, así que si `center` entrara en sus deps el mapa se recrearía
  // entero cada vez que cambiara.
  const centerRef = useRef(institutionCenter);
  centerRef.current = institutionCenter;
  const [mapboxToken, setMapboxToken] = useState<string | null>(
    (import.meta.env.VITE_MAPBOX_TOKEN as string) ?? null
  );
  const [pickingLocation, setPickingLocation] = useState(false);
  const [pickedLocation, setPickedLocation] = useState<{ lng: number; lat: number } | null>(null);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  // Alto real de la barra flotante. La vista de lista lo necesita para
  // empezar por debajo: escrito a mano como un pt-20 se quedaba corto y la
  // primera tarjeta aparecía metida bajo el buscador.
  const topBarRef = useRef<HTMLDivElement>(null);
  const [topBarHeight, setTopBarHeight] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  // Sin esto, el estado vacio parpadeaba en cada arranque en frio: hasta que
  // responde la primera consulta, "no hay eventos" y "todavia no se sabe" son
  // el mismo array vacio.
  const [eventsLoaded, setEventsLoaded] = useState(false);
  // Se alcanzó MAX_MAP_EVENTS y hay más eventos de los que caben (PERF-03).
  const [eventsTruncated, setEventsTruncated] = useState(false);
  const pickMarkerRef = useRef<MapboxMarker | null>(null);
  const userMarkerRef = useRef<MapboxMarker | null>(null);
  const hasAutoCenteredRef = useRef(false);
  /** Si la cámara acompaña al punto azul. Se apaga al mover el mapa a mano. */
  const followUserRef = useRef(true);
  const deniedToastShownRef = useRef(false);

  const { location: userLocation, error: geoError, permission } = useUserLocation({
    enableHighAccuracy: true,
    maximumAge: 4000,
    timeout: 15000,
  });


  // Eventos: carga inicial y tiempo real.
  //
  // El tiempo real ya NO vuelve a pedir la lista entera. Antes sí, con
  // `event: '*'` sobre toda la tabla: como `current_spots` es una columna de
  // `events`, cada vez que alguien se apuntaba o se salía de cualquier evento
  // se disparaba un refetch completo en TODOS los clientes conectados, y
  // detrás de cada uno una reconstrucción de todos los marcadores del mapa.
  //
  // La regla que sigue este efecto, y que es lo que lo hace seguro:
  //
  //     el payload de tiempo real nunca CONCEDE visibilidad;
  //     solo actualiza o quita algo que PostgREST ya había concedido.
  //
  // Así no depende de que la RLS esté aplicada sobre el canal de realtime, que
  // es algo que no se puede comprobar desde aquí. Lo que llega por el socket se
  // aplica tal cual únicamente si el evento ya estaba en la lista y nada de lo
  // que decide su visibilidad ha cambiado. En cuanto hay duda se le pregunta al
  // servidor por esa fila concreta: una búsqueda por clave primaria, no un
  // barrido de la tabla.
  useEffect(() => {
    let cancelled = false;

    // Ahora la lista se pide desde tres sitios —montaje, reconexión y volver
    // del segundo plano—, que en iOS coinciden con facilidad. Sin este número
    // de orden, dos peticiones en vuelo y la más vieja respondiendo la última
    // pisarían los datos nuevos. Solo escribe la última que se lanzó.
    let lastFetch = 0;

    const fetchEvents = async () => {
      const seq = ++lastFetch;
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('is_active', true)
        .gt('ends_at', new Date().toISOString())
        // Con orden y tope: sin ellos la consulta se comía el corte que
        // Supabase pone en 1.000 filas, y mil marcadores en un webview no se
        // ralentizan, se quedan clavados. Por `starts_at` ascendente, así que
        // lo que se recorta es lo que empieza más tarde.
        .order('starts_at', { ascending: true })
        // Uno más del tope, a propósito. El tope está bien puesto —mil
        // marcadores clavan el webview— pero antes recortaba EN SILENCIO: si
        // se llenaban los 500, lo que empieza más tarde simplemente no salía y
        // nadie tenía forma de saber por qué su propio evento no aparecía.
        // Pidiendo uno de más se distingue "hay 500" de "hay más de 500"; la
        // fila sobrante se descarta antes de pintar.
        .limit(MAX_MAP_EVENTS + 1);
      if (cancelled || seq !== lastFetch) return;
      // Se marca cargado tambien cuando hay error: si no, un fallo de red
      // dejaria el mapa sin pines Y sin estado vacio, o sea en blanco.
      setEventsLoaded(true);
      // Sin esto, un fallo de red dejaba el mapa sin pines y sin forma de
      // distinguirlo de "no hay eventos".
      // i18n.t y no el `t` del hook: este mensaje se lee en el momento del fallo y
      // no necesita reaccionar al idioma. Con el del hook habría que meterlo en las
      // dependencias del efecto, y cambiar de idioma reabriría la suscripción.
      if (error) {
        toast({ title: i18n.t('errors.eventsLoad'), variant: 'destructive' });
        return;
      }
      if (data) {
        setEventsTruncated(data.length > MAX_MAP_EVENTS);
        setEvents(data.slice(0, MAX_MAP_EVENTS).map(toMapEvent));
      }
    };

    // Una sola fila, por clave primaria y con los mismos filtros que la carga
    // inicial. Va por PostgREST a propósito: es quien aplica la RLS, así que si
    // el evento no me corresponde vuelve vacío y entonces se quita.
    const syncOne = async (id: string) => {
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('id', id)
        .eq('is_active', true)
        .gt('ends_at', new Date().toISOString())
        .maybeSingle();
      // Ante un fallo de red se deja lo que ya hay: borrar por no haber podido
      // preguntar sería hacer desaparecer pines buenos en cada bache.
      if (cancelled || error) return;
      if (data) upsertEvent(toMapEvent(data));
      else removeEvent(id);
    };

    const handleChange = (payload: EventChange) => {
      if (payload.eventType === 'DELETE') {
        // Con REPLICA IDENTITY DEFAULT el payload de un DELETE solo trae la
        // clave primaria, que es justo lo único que hace falta. Quitar un id
        // que no está en la lista no hace nada, así que da igual si el canal
        // reparte los borrados sin filtrar.
        const id = payload.old?.id;
        if (id) removeEvent(id);
        return;
      }

      const row = payload.new;
      if (!row?.id) return;

      const known = useEventStore.getState().events.find((e) => e.id === row.id);

      // Las reglas están en lib/eventSync.ts, con sus pruebas: es la única
      // parte de todo esto que puede fallar en silencio.
      if (needsServerCheck(known, row)) {
        syncOne(row.id);
        return;
      }

      // Ya era visible y lo sigue siendo. Aquí cae el caso frecuente —el aforo
      // subiendo y bajando— y se resuelve entero en memoria, sin tocar la red.
      upsertEvent(toMapEvent(row));
    };

    fetchEvents();

    let firstSubscribe = true;
    const channel = supabase
      .channel('events-realtime')
      .on<EventRow>('postgres_changes', { event: '*', schema: 'public', table: 'events' }, handleChange)
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        // El primer SUBSCRIBED acompaña al fetch inicial que ya se ha lanzado.
        // Los siguientes son reconexiones, y mientras el socket estuvo caído se
        // perdieron cambios: ahí sí hay que volver a pedir la lista.
        if (firstSubscribe) { firstSubscribe = false; return; }
        fetchEvents();
      });

    // Volver a la app tras un rato en segundo plano. iOS congela el webview y
    // el socket puede quedarse muerto sin llegar a reconectar. Además recupera
    // la deriva que antes corregía de rebote el refetch continuo: hay cambios
    // que alteran lo que puedes ver sin tocar ninguna fila de `events` —un
    // bloqueo, una amistad nueva— y que por el socket no llegan nunca.
    const onVisible = () => { if (document.visibilityState === 'visible') fetchEvents(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [setEvents, upsertEvent, removeEvent]);

  // Initialize map
  useEffect(() => {
    // Esperar a saber el centro: recentrar después da un tirón visible.
    if (!centerResolved) return;
    if (!mapContainer.current || mapRef.current) return;

    const initMap = () => {

      // El token de Mapbox es público por diseño: va en el bundle y se protege
      // restringiendo por dominio desde el panel de Mapbox, no escondiéndolo.
      // Aquí hubo un respaldo que pedía el token a una edge function; se quitó
      // porque esa función nunca llegó a desplegarse (devolvía 404) y, aunque
      // se hubiera desplegado, no habría protegido nada.
      const token = (import.meta.env.VITE_MAPBOX_TOKEN as string) ?? '';
      if (!token) {
        setMapboxToken(null);
        return;
      }
      setMapboxToken(token);
      mapboxgl.accessToken = token;

      const map = new mapboxgl.Map({
        container: mapContainer.current!,
        style: prefersDark() ? MAPBOX_STYLE_DARK : MAPBOX_STYLE_LIGHT,
        center: [centerRef.current.lng, centerRef.current.lat],
        zoom: 15.5,
        pitch: 0,
        attributionControl: false,
      });

      // Note: we use our own watchPosition-based marker instead of GeolocateControl

      // En cuanto la persona mueve el mapa con el dedo, se deja de seguir su
      // ubicación. Sin esto, cada lectura del GPS la devolvía a su punto en
      // cuanto lo sacaba de pantalla, que es justo lo que hace al explorar.
      // Solo cuentan los gestos (llevan originalEvent): los flyTo del propio
      // código también disparan movestart y no deben apagar el seguimiento.
      map.on('movestart', (e) => {
        if ((e as { originalEvent?: Event }).originalEvent) followUserRef.current = false;
      });

      map.on('load', () => {
        setMapLoaded(true);
        // El contenedor puede medir 0 en el primer frame (lazy-load + async);
        // reajusta el tamaño para que mapbox pida y pinte los tiles.
        map.resize();
      });

      mapRef.current = map;
      // Reajuste extra tras el layout inicial (por si el load ya disparó
      // antes de que el contenedor tuviera su tamaño final).
      requestAnimationFrame(() => map.resize());
    };

    initMap();

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [centerResolved]);

  useEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const measure = () => setTopBarHeight(el.offsetHeight);
    measure();
    // Cambia de alto al rotar, al cambiar el tamaño de letra del sistema o
    // si las pastillas pasan a dos líneas en otro idioma.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pickingLocation]);

  // El mapa vive fuera del CSS de la app: cuando el sistema cambia de tema
  // hay que cambiarle el estilo a mano. Los marcadores son elementos del DOM
  // (mapboxgl.Marker con element propio), así que sobreviven a setStyle;
  // si algún día se añaden capas o fuentes propias, habría que volver a
  // pintarlas en el evento 'style.load'.
  useEffect(() => onColorSchemeChange((dark) => {
    mapRef.current?.setStyle(dark ? MAPBOX_STYLE_DARK : MAPBOX_STYLE_LIGHT);
  }), []);

  // Marcadores.
  //
  // Tres cosas a la vez, y por eso está en una sola pasada:
  //
  //   · Se REUTILIZAN entre renders. Antes el efecto derribaba todo y lo
  //     reconstruía, y como `searchQuery` está en sus dependencias, escribir
  //     "fiesta" eran seis derribos completos.
  //
  //   · Se AGRUPAN cuando se pisan en pantalla. Con muchos eventos no se
  //     distinguía nada y Mapbox recalculaba la posición de cada uno en cada
  //     fotograma del desplazamiento.
  //
  //   · Filtrar y agrupar solo SACAN Y METEN del mapa marcadores que ya
  //     existen, con su DOM y su escuchador intactos.
  //
  // Va en un useCallback y no en un efecto porque el resultado depende del
  // zoom y del encuadre, que cambian fuera de React: hay que poder llamarlo
  // también desde el mapa.
  const syncMarkers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    // El caché pertenece a una instancia concreta del mapa: si el mapa se
    // recreara, sus nodos colgarían de un contenedor que ya no existe.
    if (markersMapRef.current !== map) {
      markersRef.current.forEach((e) => e.marker.remove());
      markersRef.current.clear();
      clustersRef.current.forEach((c) => c.marker.remove());
      clustersRef.current.clear();
      markersMapRef.current = map;
    }

    // 1. Qué va suelto, qué se agrupa y qué se conserva.
    //
    // La decisión vive en lib/mapClusters.ts con sus pruebas: es lo único de
    // todo el dibujado que puede fallar sin dar ningún error — un marcador de
    // más o de menos no lanza nada, solo hace que el mapa parpadee o que falte
    // un pin.
    const plan = planMarkers(
      events.map((e) => {
        const colocable = !!e.location && EVENT_CATEGORIES.some((c) => c.key === e.category);
        const punto = colocable ? map.project([e.location!.lng, e.location!.lat]) : { x: 0, y: 0 };
        return {
          id: e.id,
          placeable: colocable,
          passesFilter: matchesFilter(e, { category: filterCategory, query: searchQuery, ...advancedFilters }, new Date(clock)),
          x: punto.x,
          y: punto.y,
        };
      }),
      map.getZoom(),
    );
    const sueltos = plan.loose;
    const porId = new Map(events.map((e) => [e.id, e]));

    // 2. Pines sueltos.
    //
    // Se recorren TODOS los eventos, no solo los que pasan el filtro. Un
    // marcador solo se destruye cuando su evento desaparece de la lista;
    // filtrar o entrar en un racimo únicamente lo saca del mapa. Recorriendo
    // solo los filtrados, la limpieza de abajo se llevaría por delante los
    // marcadores de lo oculto y habría que rehacerlos al limpiar el buscador,
    // que es justo lo que se quitó al reutilizarlos.
    events.forEach((event) => {
      if (!event.location) return;
      const cat = EVENT_CATEGORIES.find((c) => c.key === event.category);
      if (!cat) return;

      const debeVerse = sueltos.has(event.id);
      const id = event.id;
      const { lng, lat } = event.location;
      let entry = markersRef.current.get(id);

      // Un evento oculto —por el filtro o porque vive dentro de un racimo— no
      // estrena marcador: no hay nada que enseñar todavía. Pero si ya lo tenía
      // se conserva, porque volver a usarlo cuando reaparezca es más barato
      // que construirlo otra vez.
      if (!entry && !debeVerse) return;

      if (!entry) {
        // Raíz: solo tamaño. Mapbox le escribe el transform para colocarla,
        // así que no puede llevar animaciones que lo pisen.
        const el = document.createElement('div');
        el.style.cssText = 'width: 36px; height: 36px; cursor: pointer;';

        // El hijo lleva todo lo visual y el latido.
        const inner = document.createElement('div');
        inner.className = 'animate-flag-pulse';
        inner.style.cssText = `
          width: 100%; height: 100%; border-radius: 50%;
          border: 3px solid white;
          box-shadow: 0 2px 12px rgba(0,0,0,0.2);
          display: flex; align-items: center; justify-content: center;
        `;
        el.appendChild(inner);

        let marker: MapboxMarker;
        try {
          marker = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]);
        } catch (err) {
          console.error('Failed to create marker for event:', id, err);
          return;
        }

        // Se captura el id y no el evento: el objeto cambia con cada cambio de
        // aforo, y quedarse con una copia vieja abriría la hoja con datos
        // caducados. La posición se le pregunta al marcador, que la tiene al
        // día aunque editen el sitio del evento.
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const at = marker.getLngLat();
          // Ir a un evento lejano tampoco debe deshacerse con el siguiente GPS.
          followUserRef.current = false;
          mapRef.current?.flyTo({ center: [at.lng, at.lat], zoom: 17, duration: 600 });
          const fresh = useEventStore.getState().events.find((e) => e.id === id);
          if (fresh) setSelectedEvent(fresh);
        });

        entry = { marker, inner, category: '', lng, lat, onMap: false };
        markersRef.current.set(id, entry);
      }

      // De aquí en adelante solo se toca lo que de verdad haya cambiado.
      if (entry.lng !== lng || entry.lat !== lat) {
        entry.marker.setLngLat([lng, lat]);
        entry.lng = lng;
        entry.lat = lat;
      }

      if (entry.category !== event.category) {
        entry.inner.style.background = cat.color;
        entry.inner.innerHTML = getCategoryMarkerSVG(event.category);
        entry.category = event.category;
      }

      // Sacarlo del mapa, y no esconderlo con display:none: un marcador
      // escondido le sigue costando a Mapbox recalcular su posición en cada
      // fotograma del desplazamiento. Fuera del mapa no cuesta nada, y su
      // elemento y su escuchador siguen vivos para cuando vuelva a entrar.
      if (debeVerse !== entry.onMap) {
        if (debeVerse) entry.marker.addTo(map);
        else entry.marker.remove();
        entry.onMap = debeVerse;
      }
    });

    // 3. Racimos.
    const clavesVivas = new Set<string>();

    plan.clusters.forEach((racimo) => {
      const miembros = racimo.ids.map((id) => porId.get(id)!).filter(Boolean);
      if (miembros.length === 0) return;
      clavesVivas.add(racimo.key);

      // El racimo se coloca en la media de sus miembros, para que caiga encima
      // de ellos y no en el centro geométrico de una celda vacía.
      let sumaLng = 0;
      let sumaLat = 0;
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const m of miembros) {
        const { lng, lat } = m.location!;
        sumaLng += lng;
        sumaLat += lat;
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
      const centro: [number, number] = [sumaLng / miembros.length, sumaLat / miembros.length];
      const bounds: [[number, number], [number, number]] = [
        [minLng, minLat],
        [maxLng, maxLat],
      ];

      let entry = clustersRef.current.get(racimo.key);

      if (!entry) {
        const el = document.createElement('div');
        el.style.cssText = 'width: 40px; height: 40px; cursor: pointer;';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');

        const label = document.createElement('div');
        label.style.cssText = `
          width: 100%; height: 100%; border-radius: 50%;
          background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
          border: 3px solid white; box-shadow: 0 2px 12px rgba(0,0,0,0.25);
          display: flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 13px; line-height: 1;
        `;
        el.appendChild(label);

        let marker: MapboxMarker;
        try {
          marker = new mapboxgl.Marker({ element: el }).setLngLat(centro).addTo(map);
        } catch (err) {
          console.error('Failed to create cluster marker:', racimo.key, err);
          return;
        }

        const creada: ClusterEntry = { marker, label, count: 0, bounds };
        // Lee del propio registro, que se actualiza en cada pasada: así el
        // encuadre al que lleva es siempre el de sus miembros de ahora.
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          mapRef.current?.fitBounds(creada.bounds, {
            padding: 80,
            // Por encima del umbral de agrupación a propósito: al llegar, los
            // pines ya salen sueltos. Sin esto, varios eventos en la misma
            // coordenada formarían un racimo imposible de deshacer.
            maxZoom: CLUSTER_MAX_ZOOM + 0.5,
            duration: 600,
          });
        });

        entry = creada;
        clustersRef.current.set(racimo.key, entry);
      } else {
        entry.marker.setLngLat(centro);
        entry.bounds = bounds;
      }

      if (entry.count !== miembros.length) {
        entry.count = miembros.length;
        entry.label.textContent = String(miembros.length);
        entry.marker.getElement().setAttribute(
          'aria-label',
          i18n.t('map.clusterAria', { count: miembros.length }),
        );
      }
    });

    // 4. Fuera lo que ya no toca. Borrar durante un forEach sobre un Map es
    //    seguro.
    markersRef.current.forEach((entry, id) => {
      if (plan.cached.has(id)) return;
      entry.marker.remove();
      markersRef.current.delete(id);
    });
    clustersRef.current.forEach((entry, key) => {
      if (clavesVivas.has(key)) return;
      entry.marker.remove();
      clustersRef.current.delete(key);
    });
  }, [events, filterCategory, searchQuery, advancedFilters, clock, setSelectedEvent]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    syncMarkers();
    // La agrupación es en espacio de pantalla, así que depende del zoom y del
    // encuadre. `moveend` y no `move`: rehacerlo en cada fotograma del
    // desplazamiento costaría más que lo que ahorra.
    map.on('moveend', syncMarkers);
    return () => { map.off('moveend', syncMarkers); };
  }, [syncMarkers, mapLoaded]);

  // Al desmontar: el mapa se destruye en su propio efecto y se lleva por
  // delante el DOM de los marcadores, pero el caché hay que vaciarlo a mano
  // para no dejar instancias apuntando a un mapa muerto.
  useEffect(() => () => {
    markersRef.current.forEach((e) => e.marker.remove());
    markersRef.current.clear();
    clustersRef.current.forEach((c) => c.marker.remove());
    clustersRef.current.clear();
    markersMapRef.current = null;
  }, []);

  // Handle map click for location picking
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;

    const handleClick = async (e: { lngLat: { lng: number; lat: number } }) => {
      if (!pickingLocation) return;
      const { lng, lat } = e.lngLat;
      setPickedLocation({ lng, lat });

      // Update or create the pick marker
      if (pickMarkerRef.current) pickMarkerRef.current.remove();

      const el = document.createElement('div');
      el.style.cssText = `
        width: 40px; height: 40px; border-radius: 50%;
        background: hsl(var(--primary)); border: 3px solid white;
        box-shadow: 0 2px 16px rgba(0,0,0,0.3);
        display: flex; align-items: center; justify-content: center;
      `;
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`;
      pickMarkerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(mapRef.current!);
    };

    mapRef.current.on('click', handleClick);
    return () => {
      mapRef.current?.off('click', handleClick);
    };
  }, [pickingLocation, mapLoaded]);

  /**
   * El "+" abre el FORMULARIO, no el selector de mapa.
   *
   * Antes lanzaba directamente el modo "elige un punto": tocabas el boton, no
   * aparecia ningun formulario y el mapa se veia casi igual, asi que parecia
   * que el boton no hacia nada. La ubicacion se pide ahora desde dentro del
   * formulario, donde se entiende para que es.
   */
  useEffect(() => {
    const repeat = (routerLocation.state as { repeat?: Omit<RepeatDraft, 'startsAt'> & { startsAt: string } } | null)?.repeat;
    if (!repeat) return;
    // Se consume una vez: sin limpiar el state, volver atrás o recargar
    // abriría otra vez el formulario.
    navigate('.', { replace: true, state: null });
    if (pickMarkerRef.current) {
      pickMarkerRef.current.remove();
      pickMarkerRef.current = null;
    }
    setRepeatDraft({ ...repeat, startsAt: new Date(repeat.startsAt) });
    setPickedLocation(repeat.location);
    setShowCreate(true);
  }, [routerLocation.state, navigate]);

  const handleOpenCreate = () => {
    if (pickMarkerRef.current) {
      pickMarkerRef.current.remove();
      pickMarkerRef.current = null;
    }
    setPickedLocation(null);
    setShowCreate(true);
  };

  const dismissTip = async () => {
    setTipDismissed(true);
    if (!profile) return;
    const { error } = await supabase
      .from('profiles')
      .update({ create_tip_seen: true })
      .eq('id', profile.id);
    // Si falla, el aviso ya esta oculto en esta sesion y volvera a salir la
    // proxima. Molesto, no roto: no merece un toast encima del mapa.
    if (error) console.error('create_tip_seen:', error.message);
    else fetchProfile();
  };

  /**
   * Cuando sale el aviso de primer uso.
   *
   * `=== false` a proposito, no `!profile?.create_tip_seen`: mientras la
   * columna no exista en la base llega `undefined`, y con la negacion el
   * aviso saldria SIEMPRE y no habria forma de quitarselo de encima. Con la
   * comparacion estricta, si la migracion no se ha aplicado simplemente no
   * aparece, que es el fallo seguro.
   */
  const mostrarAviso =
    !tipDismissed &&
    profile?.create_tip_seen === false &&
    viewMode === 'map' &&
    !showCreate &&
    !selectedEvent;

  /**
   * Al mapa a marcar el sitio, y de vuelta.
   *
   * Solo se entra desde el formulario, asi que confirmar y cancelar vuelven
   * siempre a el. Antes hacia falta recordar de donde se venia porque el "+"
   * tambien abria el selector a secas.
   *
   * `showCreate` NO se toca aqui: ponerlo en false desmontaba
   * CreateEventSheet, y al volver el formulario se montaba de cero con el
   * titulo, la fecha, la hora y la descripcion en blanco. La hoja se queda
   * montada y solo se aparta de la vista (prop `hidden`).
   */
  const handleStartPicking = () => {
    setPickingLocation(true);
  };

  const handleConfirmLocation = () => {
    setPickingLocation(false);
  };

  const handleCancelPicking = () => {
    setPickingLocation(false);
    if (pickMarkerRef.current) {
      pickMarkerRef.current.remove();
      pickMarkerRef.current = null;
    }
  };

  const handleCloseCreate = () => {
    setShowCreate(false);
    setRepeatDraft(null);
    setPickedLocation(null);
    if (pickMarkerRef.current) {
      pickMarkerRef.current.remove();
      pickMarkerRef.current = null;
    }
  };

  // Live user location → reuse a single marker, smooth camera updates
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || !userLocation) return;
    let cancelled = false;

    (async () => {
      if (cancelled) return;
      const lngLat: [number, number] = [userLocation.lng, userLocation.lat];

      if (!userMarkerRef.current) {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        el.innerHTML = '<div class="user-location-marker__pulse"></div><div class="user-location-marker__dot"></div>';
        userMarkerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat(lngLat)
          .addTo(mapRef.current);
      } else {
        userMarkerRef.current.setLngLat(lngLat);
      }

      // Auto-center on first fix; afterwards only easeTo softly if user is far
      // off-screen, and only while they haven't moved the map themselves.
      if (!hasAutoCenteredRef.current) {
        hasAutoCenteredRef.current = true;
        mapRef.current.flyTo({ center: lngLat, zoom: 16, duration: 900, essential: true });
      } else if (followUserRef.current) {
        const bounds = mapRef.current.getBounds();
        if (bounds && !bounds.contains(lngLat)) {
          mapRef.current.easeTo({ center: lngLat, duration: 800 });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [userLocation, mapLoaded]);

  // Cleanup marker on unmount
  useEffect(() => () => {
    if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
  }, []);

  // Surface permission/GPS errors once.
  //
  // La condición mira también `location`: watchPosition puede entregar un
  // error DESPUÉS de haber dado posiciones buenas (precisión aproximada,
  // un fallo puntual del GPS), y entonces salía un aviso de "ubicación
  // denegada" con el punto azul pintado en el mapa, contradiciéndose solo.
  //
  // Y no solo después: en frío, CoreLocation puede entregar un
  // PERMISSION_DENIED transitorio mientras todavía está confirmando la
  // autorización recién concedida, y la posición buena llega un instante
  // después. Por eso el aviso espera un margen antes de salir: si en ese
  // rato llega la ubicación (o el permiso dejó de estar denegado), el aviso
  // ni se lanza.
  useEffect(() => {
    if (userLocation) {
      // Si acabó llegando la posición, el aviso vuelve a estar disponible
      // por si de verdad se revoca el permiso más adelante.
      deniedToastShownRef.current = false;
      return;
    }
    if (deniedToastShownRef.current) return;

    // Quién decide que está denegado: SOLO el error del propio geolocation,
    // que es el único que habla con el sistema operativo. `permission` ya no
    // sirve para esto: dentro del webview lo alimenta navigator.permissions,
    // que responde por el origen capacitor://localhost y dice `denied` con el
    // permiso nativo perfectamente concedido. De ahí venía el aviso de
    // "ubicación denegada" con la ubicación funcionando.
    const denegadoDeVerdad = !!geoError && geoError.code === geoError.PERMISSION_DENIED;
    if (!denegadoDeVerdad && permission !== 'unsupported') return;

    const timer = setTimeout(() => {
      deniedToastShownRef.current = true;
      if (denegadoDeVerdad) {
        toast({
          title: t('map.locDenied'),
          description: t('map.locDeniedDesc'),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('map.gpsUnavailable'),
          description: t('map.gpsUnavailableDesc'),
          variant: 'destructive',
        });
      }
      // Margen antes de avisar. En frío, CoreLocation puede soltar un
      // PERMISSION_DENIED pasajero mientras confirma una autorización recién
      // concedida, y la posición buena llega detrás. Con 2,5 s el aviso salía
      // igualmente en cuanto el GPS tardaba un poco en el primer arranque.
    }, 5000);
    return () => clearTimeout(timer);
  }, [permission, geoError, userLocation, t]);

  useEffect(() => {
    if (geoError && geoError.code !== geoError.PERMISSION_DENIED) {
      toast({
        title: t('map.locError'),
        description: geoError.message || t('map.locErrorDesc'),
      });
    }
  }, [geoError, t]);

  const handleRecenter = useCallback(() => {
    if (!mapRef.current || !userLocation) {
      toast({ title: t('map.waitingGps'), description: t('map.waitingGpsDesc') });
      return;
    }
    followUserRef.current = true;
    mapRef.current.flyTo({
      center: [userLocation.lng, userLocation.lat],
      zoom: 16.5,
      duration: 700,
      essential: true,
    });
  }, [userLocation, t]);

  const filteredCategories: Array<{ key: string | null; label: string; Icon: LucideIcon }> = [
    { key: null, label: t('map.all'), Icon: Layers },
    ...EVENT_CATEGORIES.map(c => ({ key: c.key as string | null, label: c.label, Icon: CATEGORY_ICONS[c.key] })),
  ];


  return (
    <div className="relative w-full h-screen">
      <Helmet>
        <title>{pageTitle(t('map.title'))}</title>
        <meta name="description" content={t('map.metaDesc')} />
        <link rel="canonical" href="/" />
        <meta property="og:title" content={pageTitle(t('map.title'))} />
        <meta property="og:description" content={t('map.metaDesc')} />
        <meta property="og:url" content="/" />
      </Helmet>
      <h1 className="sr-only">{t('map.title')}</h1>
      {/* Map container — altura explícita (h-full/w-full) porque mapbox añade
          .mapboxgl-map { position: relative }, que pisa el `absolute` y, sin
          altura propia, el contenedor colapsa a 0 → mapa en blanco. */}
      <div ref={mapContainer} className="absolute inset-0 h-full w-full" />

      {/* Fallback if no mapbox token */}
      {!mapboxToken && (
        <div className="absolute inset-0 bg-muted flex items-center justify-center">
          <div className="text-center p-6 space-y-3">
            <MapIcon aria-hidden="true" className="w-12 h-12 mx-auto text-muted-foreground" />
            <h2 className="text-lg font-bold text-foreground">Map Preview</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              Add your Mapbox token as VITE_MAPBOX_TOKEN to see the interactive map.
              Events will still appear below.
            </p>
            <div className="mt-4 space-y-2 max-h-60 overflow-y-auto">
              {events.map(event => {
                const cat = EVENT_CATEGORIES.find(c => c.key === event.category);
                return (
                  <button
                    key={event.id}
                    onClick={() => setSelectedEvent(event)}
                    className="w-full p-3 bg-card rounded-xl shadow-soft text-left"
                  >
                    <div className="flex items-center gap-2">
                      {cat && (() => { const Icon = CATEGORY_ICONS[cat.key]; return <Icon className="w-4 h-4 text-muted-foreground" />; })()}
                      <span className="font-semibold text-sm">{event.title}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Location picker overlay */}
      {pickingLocation && (
        <LocationPickerOverlay
          onConfirm={handleConfirmLocation}
          onCancel={handleCancelPicking}
          hasPin={!!pickedLocation}
        />
      )}

      {/* Filter pills + view toggle - hide during picking.

          z-20 y no z-10: la vista de lista es un `absolute inset-0` que va
          después en el DOM, así que con el mismo z-10 tapaba esta barra
          entera — incluido el botón que devuelve al mapa, y no había forma
          de salir de la lista. La lista reserva 5rem arriba precisamente
          para dejar ver esta barra. */}
      {!pickingLocation && (
        <div
          ref={topBarRef}
          className={cn(
            'absolute top-0 left-0 right-0 z-20 px-4 pb-3 pt-[calc(1rem+env(safe-area-inset-top,0px))]',
            // Sobre el mapa flota transparente. Sobre la lista se convierte
            // en cabecera: sin fondo, las tarjetas se veían pasar por los
            // huecos entre las pastillas al hacer scroll.
            viewMode === 'list' && 'bg-background/85 backdrop-blur-xl border-b border-border',
          )}
        >
          {/* Search bar */}
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('map.searchEvents')}
                // text-base y no text-sm: por debajo de 16px, iOS hace zoom
                // automatico del viewport al enfocar el campo, y como el mapa
                // no reacciona a ese cambio, se queda enganchado en ese zoom.
                className="w-full h-11 pl-9 pr-11 rounded-full text-base font-medium border border-border shadow-soft bg-background/80 backdrop-blur-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  aria-label={t('common.clearSearch')}
                  className="absolute right-0 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center text-muted-foreground"
                >
                  <XIcon className="w-4 h-4" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              aria-label={activeFilterCount ? t('map.filters.buttonActive', { count: activeFilterCount }) : t('map.filters.button')}
              aria-haspopup="dialog"
              className={cn(
                'relative flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center shadow-soft border',
                activeFilterCount ? 'bg-primary text-primary-foreground border-primary' : 'glass text-foreground border-border',
              )}
            >
              <SlidersHorizontal className="w-4 h-4" />
              {activeFilterCount > 0 && (
                <span aria-hidden="true" className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-background text-primary text-[11px] font-bold flex items-center justify-center border border-primary">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <div className="flex gap-2 overflow-x-auto no-scrollbar py-1 flex-1">
              {filteredCategories.map(cat => (
                <button
                  key={cat.key ?? 'all'}
                  onClick={() => setFilterCategory(cat.key)}
                  className={cn(
                    'flex items-center gap-1.5 min-h-[44px] px-4 rounded-full text-xs font-semibold whitespace-nowrap transition-all shadow-soft',
                    filterCategory === cat.key
                      ? 'bg-primary text-primary-foreground'
                      : 'glass text-foreground border border-border'
                  )}
                >
                  <cat.Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{cat.key != null ? t('categories.' + cat.key) : cat.label}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setViewMode(v => v === 'map' ? 'list' : 'map')}
              aria-label={viewMode === 'map' ? t('map.listView') : t('map.mapView')}
              className="flex-shrink-0 w-11 h-11 rounded-full glass border border-border flex items-center justify-center shadow-soft text-foreground"
            >
              {viewMode === 'map' ? <List className="w-4 h-4" /> : <MapIcon className="w-4 h-4" />}
            </button>
          </div>
          {activeFilterCount > 0 && <ActiveFilterChips onOpen={() => setFiltersOpen(true)} />}
        </div>
      )}

      {/* List view overlay */}
      {!pickingLocation && viewMode === 'list' && (
        <div
          className="absolute inset-0 z-10 bg-background overflow-y-auto px-4 pb-nav pt-[calc(8.5rem+env(safe-area-inset-top,0px))]"
          // El valor de la clase es solo el respaldo para el primer pintado,
          // antes de que la barra se haya medido.
          style={topBarHeight ? { paddingTop: topBarHeight + 12 } : undefined}
        >
          <EventListView
            events={events}
            filter={{ category: filterCategory, query: searchQuery, ...advancedFilters }}
            now={new Date(clock)}
            onSelect={(event) => { setSelectedEvent(event); setViewMode('map'); }}
            onCreate={handleOpenCreate}
            onClearFilters={() => { resetFilters(); setSearchQuery(''); }}
          />
        </div>
      )}

      {/* Recenter on user - hide during picking */}
      {!pickingLocation && (
        <button
          onClick={handleRecenter}
          aria-label={t('map.recenter')}
          className={cn(
            'absolute above-nav mb-24 right-4 z-10 w-12 h-12 rounded-full flex items-center justify-center shadow-lifted active:scale-95 transition-all glass border border-border',
            userLocation ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          <LocateFixed className="w-5 h-5" />
        </button>
      )}

      {/* FAB extendido - hide during picking.

          Con etiqueta y no solo el icono: un "+" a secas no dice que crea
          eventos, y era el punto donde la gente se quedaba parada. Siempre
          extendido, sin colapsar al hacer scroll: el mapa no scrollea y solo
          hay un boton, asi que encogerlo seria movimiento sin motivo. */}
      {!pickingLocation && (
        <>
          {mostrarAviso && <WelcomeTour onFinish={dismissTip} />}
          <button
            onClick={handleOpenCreate}
            aria-label={t('map.createEvent')}
            // Ancla del recorrido de bienvenida. Ver WelcomeTour.
            data-tour="create"
            className="absolute above-nav mb-4 right-4 z-10 h-14 pl-5 pr-6 bg-primary rounded-full flex items-center gap-2 shadow-lifted active:scale-95 transition-transform"
          >
            <Plus className="w-6 h-6 text-primary-foreground flex-shrink-0" />
            <span className="text-primary-foreground font-bold text-sm whitespace-nowrap">
              {t('map.createEventLabel')}
            </span>
          </button>
        </>
      )}

      {/* Estado vacio del mapa. La lista tiene el suyo; el mapa no tenia
          ninguno, y un mapa sin pines no se distingue de uno roto. Solo
          cuando de verdad no hay NADA: si hay eventos y el filtro no los
          deja pasar, los pines vuelven al quitar el filtro y no hace falta
          tapar el mapa. */}
      {!pickingLocation && viewMode === 'map' && eventsLoaded && events.length === 0 && !showCreate && (
        <div className="absolute inset-x-0 above-nav mb-24 z-10 px-6 pointer-events-none">
          <div className="pointer-events-auto mx-auto sm:max-w-[430px] bg-card/95 backdrop-blur-md rounded-2xl shadow-lifted border border-border p-5 text-center">
            <p className="text-base font-bold text-foreground">{t('map.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground mt-1">{t('map.emptyBody')}</p>
            <button
              onClick={handleOpenCreate}
              className="mt-4 inline-flex items-center gap-2 min-h-[44px] px-5 rounded-xl bg-primary text-primary-foreground text-sm font-bold"
            >
              <Plus aria-hidden="true" className="w-4 h-4" />
              {t('map.emptyCta')}
            </button>
          </div>
        </div>
      )}

      {/* Hay eventos pero los filtros no dejan pasar ninguno. Con solo la
          categoría no hacía falta avisar; con "Mañana por la noche" un mapa
          sin pines parece roto. */}
      {!pickingLocation && viewMode === 'map' && eventsLoaded && events.length > 0 && !showCreate && !selectedEvent
        && filterEvents(events, { category: filterCategory, query: searchQuery, ...advancedFilters }, new Date(clock)).length === 0 && (
        <div className="absolute inset-x-0 above-nav mb-24 z-10 px-6 pointer-events-none">
          <div role="status" className="pointer-events-auto mx-auto sm:max-w-[430px] bg-card/95 backdrop-blur-md rounded-2xl shadow-lifted border border-border p-4 text-center">
            <p className="text-sm font-semibold text-foreground">{t('map.filters.mapNoMatch')}</p>
            <button
              onClick={() => { resetFilters(); setSearchQuery(''); }}
              className="mt-3 inline-flex items-center min-h-[44px] px-5 rounded-xl bg-muted text-foreground text-sm font-semibold"
            >
              {t('map.clearFilters')}
            </button>
          </div>
        </div>
      )}

      {/* El mapa se quedó en los 500 más próximos. Discreto y arriba, porque
          no es un error: es que hay tanta actividad que no cabe. Sin esto, el
          recorte era invisible y quien no veía su propio evento no tenía nada
          que mirar para entender por qué. */}
      {!pickingLocation && viewMode === 'map' && eventsTruncated && !showCreate && !selectedEvent && (
        <div className="absolute inset-x-0 top-0 pt-safe z-10 px-6 pointer-events-none">
          <div
            role="status"
            className="mt-2 mx-auto sm:max-w-[430px] bg-card/95 backdrop-blur-md rounded-xl shadow-lifted border border-border px-4 py-2 text-center"
          >
            <p className="text-xs text-muted-foreground">
              {t('map.truncated', { count: MAX_MAP_EVENTS })}
            </p>
          </div>
        </div>
      )}

      <EventFiltersSheet open={filtersOpen} onOpenChange={setFiltersOpen} events={events} searchQuery={searchQuery} />

      {/* Event bottom sheet */}
      {selectedEvent && (
        <EventBottomSheet
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}

      {/* Create event sheet */}
      {showCreate && (
        <CreateEventSheet
          onClose={handleCloseCreate}
          onPickLocation={handleStartPicking}
          pickedLocation={pickedLocation}
          hidden={pickingLocation}
          initial={repeatDraft}
        />
      )}
    </div>
  );
}
