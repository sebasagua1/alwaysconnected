import Foundation
import UIKit
import SwiftUI
import Contacts
import ContactsUI
import Capacitor

/// Contactos y compartir, sin plugins de terceros.
///
/// Por qué propio y no @capacitor-community/contacts: hacía falta el acceso
/// LIMITADO de iOS 18 (estado `.limited` y el selector `contactAccessPicker`
/// para ampliar la selección) y el selector del sistema que NO pide permiso
/// (`CNContactPickerViewController`). Así la persona puede elegir contactos
/// sueltos sin dar acceso a la agenda entera.
///
/// Solo devuelve lo que la app necesita para buscar e invitar: nombre,
/// teléfonos y correos. Nada de esto se sube tal cual: la app lo normaliza y
/// solo manda su SHA-256 (ver src/lib/contacts.ts).
@objc(ContactsBridgePlugin)
public class ContactsBridgePlugin: CAPPlugin, CAPBridgedPlugin, CNContactPickerDelegate {
    public let identifier = "ContactsBridgePlugin"
    public let jsName = "ContactsBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readContacts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickContacts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageLimitedAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
    ]

    private let store = CNContactStore()
    private var pickerCall: CAPPluginCall?

    private static let keys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor,
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
    ]

    // MARK: - Permiso

    private func status() -> String {
        let s = CNContactStore.authorizationStatus(for: .contacts)
        switch s {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        default:
            // .limited existe desde iOS 18; la app admite iOS 15, así que se
            // mira con #available en vez de nombrarlo como caso.
            if #available(iOS 18.0, *), s == .limited { return "limited" }
            return "denied"
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(["status": status(), "limitedPickerAvailable": limitedPickerAvailable()])
    }

    /// Pide permiso solo si nunca se pidió. Si ya se contestó, iOS no vuelve
    /// a enseñar el diálogo: se devuelve el estado y la app ofrece Ajustes.
    @objc func requestAccess(_ call: CAPPluginCall) {
        guard CNContactStore.authorizationStatus(for: .contacts) == .notDetermined else {
            call.resolve(["status": status()])
            return
        }
        store.requestAccess(for: .contacts) { [weak self] _, _ in
            call.resolve(["status": self?.status() ?? "denied"])
        }
    }

    // MARK: - Leer

    /// Todos los contactos a los que la app tiene acceso (todos, o solo los
    /// elegidos si el acceso es limitado). En segundo plano: una agenda grande
    /// tarda y no debe congelar la interfaz.
    @objc func readContacts(_ call: CAPPluginCall) {
        let max = min(call.getInt("max") ?? 3000, 5000)
        let st = status()
        guard st == "authorized" || st == "limited" else {
            call.reject("Sin permiso para leer contactos", "NOT_AUTHORIZED")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [store] in
            let request = CNContactFetchRequest(keysToFetch: ContactsBridgePlugin.keys)
            request.sortOrder = .userDefault
            var out: [[String: Any]] = []
            do {
                try store.enumerateContacts(with: request) { contact, stop in
                    if out.count >= max { stop.pointee = true; return }
                    if let js = ContactsBridgePlugin.toJS(contact) { out.append(js) }
                }
                call.resolve(["contacts": out])
            } catch {
                call.reject("No se pudieron leer los contactos", "READ_FAILED", error)
            }
        }
    }

    private static func toJS(_ c: CNContact) -> [String: Any]? {
        var phones: [String] = []
        var emails: [String] = []
        // Del selector del sistema pueden llegar contactos a medias: se mira
        // cada clave antes de leerla, o CNContact lanza una excepción de ObjC
        // que ningún do/catch de Swift atrapa.
        if c.isKeyAvailable(CNContactPhoneNumbersKey) {
            phones = c.phoneNumbers.map { $0.value.stringValue }
        }
        if c.isKeyAvailable(CNContactEmailAddressesKey) {
            emails = c.emailAddresses.map { String($0.value) }
        }
        if phones.isEmpty && emails.isEmpty { return nil }

        var name = ""
        if c.isKeyAvailable(CNContactGivenNameKey) && c.isKeyAvailable(CNContactFamilyNameKey) {
            name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
        }
        if name.isEmpty && c.isKeyAvailable(CNContactOrganizationNameKey) {
            name = c.organizationName
        }
        return [
            "id": c.identifier,
            "name": name,
            "phones": Array(phones.prefix(10)),
            "emails": Array(emails.prefix(10)),
        ]
    }

    // MARK: - Elegir sin dar permiso

    /// El selector del sistema: corre fuera de la app y no necesita permiso.
    /// Devuelve solo los contactos que la persona toca.
    @objc func pickContacts(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let vc = self.bridge?.viewController else {
                call.reject("Sin vista para presentar el selector", "UNAVAILABLE")
                return
            }
            if self.pickerCall != nil {
                call.reject("Ya hay un selector abierto", "BUSY")
                return
            }
            self.pickerCall = call
            let picker = CNContactPickerViewController()
            picker.delegate = self
            picker.displayedPropertyKeys = [CNContactPhoneNumbersKey, CNContactEmailAddressesKey]
            // Solo contactos con algo con lo que buscar o invitar.
            picker.predicateForEnablingContact = NSPredicate(format: "phoneNumbers.@count > 0 OR emailAddresses.@count > 0")
            vc.present(picker, animated: true)
        }
    }

    public func contactPicker(_ picker: CNContactPickerViewController, didSelect contacts: [CNContact]) {
        let out = contacts.compactMap { ContactsBridgePlugin.toJS($0) }
        pickerCall?.resolve(["contacts": out, "cancelled": false])
        pickerCall = nil
    }

    public func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        pickerCall?.resolve(["contacts": [], "cancelled": true])
        pickerCall = nil
    }

    // MARK: - Ampliar el acceso limitado (iOS 18)

    private func limitedPickerAvailable() -> Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }

    /// Con acceso limitado, el selector de iOS 18 para añadir más contactos
    /// a los compartidos sin pasar por Ajustes. Antes de iOS 18 no existe el
    /// acceso limitado, así que devuelve available = false.
    @objc func manageLimitedAccess(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            call.resolve(["available": false, "added": 0])
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let vc = self?.bridge?.viewController else {
                call.reject("Sin vista para presentar el selector", "UNAVAILABLE")
                return
            }
            var finished = false
            var host: UIViewController?
            let view = LimitedAccessPickerView { ids in
                guard !finished else { return }
                finished = true
                host?.dismiss(animated: false) {
                    call.resolve(["available": true, "added": ids.count])
                }
            }
            let controller = UIHostingController(rootView: view)
            controller.modalPresentationStyle = .overFullScreen
            controller.view.backgroundColor = .clear
            host = controller
            vc.present(controller, animated: false)
        }
    }

    // MARK: - Ajustes

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.resolve(["opened": false])
                return
            }
            UIApplication.shared.open(url) { ok in call.resolve(["opened": ok]) }
        }
    }

    // MARK: - Compartir

    /// La hoja de compartir del sistema (Mensajes, WhatsApp, Mail…). Nada se
    /// envía sin que la persona elija la app y confirme en ella.
    @objc func share(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let urlString = call.getString("url")
        DispatchQueue.main.async { [weak self] in
            guard let vc = self?.bridge?.viewController else {
                call.reject("Sin vista para compartir", "UNAVAILABLE")
                return
            }
            var items: [Any] = [text]
            if let s = urlString, let url = URL(string: s) { items.append(url) }
            let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
            activity.popoverPresentationController?.sourceView = vc.view
            activity.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY, width: 0, height: 0)
            activity.completionWithItemsHandler = { type, completed, _, _ in
                call.resolve(["completed": completed, "activityType": type?.rawValue ?? ""])
            }
            vc.present(activity, animated: true)
        }
    }
}

/// Vista vacía que solo sirve para presentar el selector de iOS 18.
@available(iOS 18.0, *)
private struct LimitedAccessPickerView: View {
    @State private var presented = false
    let onDone: ([String]) -> Void

    var body: some View {
        Color.clear
            .contactAccessPicker(isPresented: $presented) { identifiers in
                onDone(identifiers)
            }
            .onAppear { presented = true }
            .onChange(of: presented) { _, isPresented in
                // Cerrado sin elegir nada.
                if !isPresented { onDone([]) }
            }
    }
}
