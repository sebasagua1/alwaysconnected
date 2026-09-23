import UIKit
import Capacitor

/// El controlador de la app: el de Capacitor más los plugins propios que
/// viven dentro de este proyecto (no en node_modules), que hay que
/// registrar a mano porque `cap sync` solo conoce los de npm.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ContactsBridgePlugin())
    }
}
