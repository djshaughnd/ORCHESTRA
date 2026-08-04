#include <iostream>
#include "CameraRemote_SDK.h"
#include "ICrCameraObjectInfo.h"
namespace SDK = SCRSDK;
int main() {
    if (!SDK::Init()) { std::cout << "Init FAILED\n"; return 1; }
    SDK::ICrEnumCameraObjectInfo* list = nullptr;
    auto err = SDK::EnumCameraObjects(&list, 5);
    if (err != 0 || !list) { std::cout << "Enumerate err=0x" << std::hex << err << "\n"; SDK::Release(); return 1; }
    auto n = list->GetCount();
    std::cout << "cameras=" << n << "\n";
    for (CrInt32u i = 0; i < n; ++i) {
        auto* c = list->GetCameraObjectInfo(i);
        if (!c) continue;
        std::cout << "--- camera " << i << " ---\n";
        std::cout << "  model:      " << c->GetModel() << "\n";
        std::cout << "  name:       " << c->GetName() << "\n";
        std::cout << "  connection: " << c->GetConnectionTypeName() << "\n";
        std::cout << "  adaptor:    " << c->GetAdaptorName() << "\n";
        std::cout << "  pairing:    " << c->GetPairingNecessity() << "\n";
        std::cout << "  usbPid:     0x" << std::hex << c->GetUsbPid() << std::dec << "\n";
    }
    list->Release();
    SDK::Release();
    return 0;
}
