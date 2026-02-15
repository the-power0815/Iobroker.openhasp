# ioBroker.openhasp (v0.0.1)

**Read‑only Fix:** Der Konfig‑Leser **bevorzugt numerische Keys (1..6)**, wenn vorhanden, und **prüft Typen** der benannten Keys. So werden Altfehler (z. B. `mqttUser=1883` oder `mqttBaseTopic='Kl-...'`) ignoriert. Es gibt **keine Schreibzugriffe** auf die Instanz.

**Mapping (nur Lesen):** 1→Host, 2→Port, 3→User, 4→Password, 5→BaseTopic, 6→useTLS.
