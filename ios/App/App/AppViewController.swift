import UIKit
import Capacitor

/// El controlador de la app: el de Capacitor más los plugins propios que
/// viven dentro de este proyecto (no en node_modules), que hay que
/// registrar a mano porque `cap sync` solo conoce los de npm.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ContactsBridgePlugin())
        // Volver deslizando desde el borde izquierdo, como en cualquier app de
        // iOS. WKWebView lo trae apagado y había que buscar la flecha de
        // arriba a la izquierda, lo más lejos del pulgar. Funciona con el
        // historial de react-router: las pestañas SUSTITUYEN la entrada
        // (BottomNav), así que el gesto vuelve de un detalle a su pantalla y
        // no va saltando entre pestañas.
        webView?.allowsBackForwardNavigationGestures = true
    }
}
