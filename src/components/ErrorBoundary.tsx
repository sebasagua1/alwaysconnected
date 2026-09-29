import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import i18n from '@/i18n';
import { hideBootSplash } from '@/lib/bootSplash';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Última red de seguridad de la app. Va FUERA del router (main.tsx), así que
 * aquí no hay navegación de react-router ni hooks: los textos se leen con
 * `i18n.t` en el render, no con useTranslation.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled error:', error, info.componentStack);
    // Si revienta durante el arranque, la pantalla de entrada (que va fuera
    // de React, en index.html) taparía este aviso y la app parecería colgada.
    hideBootSplash();
  }

  /**
   * Volver a montar los hijos sin recargar.
   *
   * Antes el único botón hacía `location.replace('/')`, que tira la sesión de
   * navegación entera por un fallo que puede ser de una sola pantalla. La
   * mayoría de lo que cae aquí es transitorio —un import dinámico que no bajó,
   * un bache de red—, y para eso basta con reintentar. Si el fallo es
   * determinista volverá a saltar y queda el botón de recargar.
   */
  private handleRetry = () => this.setState({ hasError: false });

  private handleReload = () => window.location.replace('/');

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-background"
        >
          <AlertTriangle aria-hidden="true" className="w-12 h-12 text-warning" />
          <h1 className="text-xl font-bold text-foreground">{i18n.t('errors.crashTitle')}</h1>
          <p className="text-sm text-muted-foreground max-w-xs">{i18n.t('errors.crashBody')}</p>
          <div className="flex flex-col gap-2 w-full max-w-[240px] mt-2">
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center justify-center min-h-[44px] px-6 bg-primary text-primary-foreground rounded-xl font-semibold text-sm"
            >
              {i18n.t('errors.crashRetry')}
            </button>
            <button
              onClick={this.handleReload}
              className="inline-flex items-center justify-center min-h-[44px] px-6 bg-muted text-muted-foreground rounded-xl font-semibold text-sm"
            >
              {i18n.t('errors.crashHome')}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
