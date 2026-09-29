import { lazy, useState, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Como `React.lazy`, pero con `preload()` y sin pasar por Suspense si el
 * código ya bajó.
 *
 * Con `lazy` a secas, la primera visita a cada pestaña enseñaba la rueda de
 * Suspense mientras bajaba su trozo de JS, y la pantalla entraba a saltos. Y
 * precargar el `import()` por separado no bastaba: aunque el módulo ya esté
 * en memoria, `lazy` suspende igual una vez en su primer render (resuelve la
 * promesa en diferido). Aquí, una vez cargado, se pinta el componente tal
 * cual: la primera visita es igual de inmediata que la segunda.
 */
export function lazyPage(factory: () => Promise<{ default: ComponentType }>) {
  let Loaded: ComponentType | null = null;
  let loading: Promise<ComponentType> | null = null;

  const preload = () => {
    if (!loading) {
      loading = factory().then((m) => {
        Loaded = m.default;
        return m.default;
      });
      // Si falla, que el siguiente intento vuelva a pedirlo en vez de
      // quedarse con la promesa rota para siempre.
      loading.catch(() => { loading = null; });
    }
    return loading;
  };

  const Lazy = lazy(() => preload().then((component) => ({ default: component })));

  // Sin props: son pantallas de ruta (`element={<MapHome />}`).
  function Page() {
    // Se decide UNA vez por montaje. Si esta instancia empezó por `Lazy` y
    // luego terminó la precarga, pasar a `Loaded` cambiaría el tipo de
    // elemento y React la desmontaría entera: perdería su estado.
    const [Component] = useState<ComponentType | LazyExoticComponent<ComponentType>>(
      () => Loaded ?? Lazy,
    );
    return <Component />;
  }
  Page.preload = preload;
  return Page;
}
