import UIKit
import WebKit
import Capacitor

/// El controlador de la app: el de Capacitor más los plugins propios que
/// viven dentro de este proyecto (no en node_modules), que hay que
/// registrar a mano porque `cap sync` solo conoce los de npm.
class AppViewController: CAPBridgeViewController {
    private var loadingObservation: NSKeyValueObservation?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ContactsBridgePlugin())
        bridge?.registerPluginInstance(LaunchScreenPlugin())
        // Volver deslizando desde el borde izquierdo, como en cualquier app de
        // iOS. WKWebView lo trae apagado y había que buscar la flecha de
        // arriba a la izquierda, lo más lejos del pulgar. Funciona con el
        // historial de react-router: las pestañas SUSTITUYEN la entrada
        // (BottomNav), así que el gesto vuelve de un detalle a su pantalla y
        // no va saltando entre pestañas.
        webView?.allowsBackForwardNavigationGestures = true

        applyLaunchAppearance()
        // Cada carga de la página vuelve a enseñar la pantalla de entrada: el
        // Reintentar de la web recarga, e iOS recarga el webview por su cuenta
        // si le mata el proceso por memoria (el mapa gasta mucha). En esas
        // cargas también hacen falta el azul de fondo y la barra en blanco.
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            guard webView.isLoading else { return }
            DispatchQueue.main.async { self?.applyLaunchAppearance() }
        }
    }

    /// Mientras carga la página, el webview es transparente (Capacitor lo
    /// pone así para no enseñar su blanco) y deja ver su color de fondo, que
    /// por defecto es el del sistema: NEGRO en modo oscuro y BLANCO en claro.
    /// Era el fogonazo entre la pantalla de lanzamiento y la de la web. Con el
    /// mismo azul que las dos (LaunchBackground en Assets.xcassets, y el
    /// #141734 de index.html), el paso no se nota.
    private func applyLaunchAppearance() {
        let launch = UIColor(named: "LaunchBackground") ?? .systemBackground
        webView?.backgroundColor = launch
        webView?.scrollView.backgroundColor = launch
        // Blanco sobre el azul, en claro y en oscuro. Al arrancar ya viene así
        // de Info.plist (UIStatusBarStyle); esto es para las recargas.
        setStatusBarStyle(.lightContent)
    }

    /// La web avisa de que su pantalla de entrada se va (src/lib/bootSplash.ts)
    /// y todo vuelve a lo del sistema. Sin esto la barra de estado seguiría en
    /// blanco encima de las pantallas claras de la app.
    func launchScreenDidHide() {
        webView?.backgroundColor = .systemBackground
        webView?.scrollView.backgroundColor = .systemBackground
        setStatusBarStyle(.default)
    }
}

/// El puente de la pantalla de entrada: un solo método, `hide`, que la web
/// llama cuando su pantalla de entrada empieza a fundirse.
@objc(LaunchScreenPlugin)
public class LaunchScreenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LaunchScreenPlugin"
    public let jsName = "LaunchScreen"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
    ]

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            (self.bridge?.viewController as? AppViewController)?.launchScreenDidHide()
            call.resolve()
        }
    }
}
