# matterbridge-homewizard-power

Matterbridge-plugin (Luligu) die het lokale HomeWizard Energy-API uitleest en een Matter **Electrical Sensor** publiceert. Apple Home, Home Assistant en SmartThings lezen daarmee vermogen (W) en cumulatieve import/export (kWh).

## EnergyKit

Apple **EnergyKit** is een iOS-framework met entitlement (`com.apple.developer.energykit`). Alleen een eigen app (HVAC of EV-lader) mag daarmee load-events naar de Woning-app sturen. Een Matter-bridge kan EnergyKit niet aanroepen.

Wat de Woning-app wél uit een bridge haalt, zijn de Matter 1.3-clusters:

- Electrical Power Measurement (`activePower`, `voltage`, `activeCurrent`)
- Electrical Energy Measurement (`cumulativeEnergyImported`, `cumulativeEnergyExported`)
- Power Topology

Die clusters zijn precies wat controllers gebruiken voor het energie-overzicht. Op iOS-versies die een kale Electrical Sensor nog niet in Energie tonen, zet je `exposeAs` op `outlet`. Het apparaat komt dan binnen als energie-stekker (virtueel; uit zetten wordt genegeerd).

## Ondersteunde meters

- P1 Meter (`HWE-P1`) — vermogen, import/export, fases, gas wordt gelogd
- kWh Meter 1- en 3-fase
- Energy Socket (v1)
- Plug-In Battery (v2; laadstand wordt gelogd)

## API

v1: in de Energy-app Local API aanzetten. `GET http://<ip>/api/v1/data`

v2: token halen (knop op de meter één keer indrukken):

```bash
curl --insecure -X POST "https://<ip>/api/user" -d '{"name":"local/matterbridge-homewizard-power"}'
```

Token in de pluginconfig zetten. Meting: `GET https://<ip>/api/measurement` met `Authorization: Bearer …` en `X-Api-Version: 2`.

## Installeren

```bash
cd ~/Matterbridge
git clone <dit-project> matterbridge-homewizard-power
cd matterbridge-homewizard-power
npm install
npm link matterbridge
npm run build
matterbridge --add .
```

Daarna in de frontend het IP-adres invullen en Matterbridge herstarten. Bridge één keer koppelen in de Woning-app.

Eenheden naar Matter: W → mW, V → mV, A → mA, kWh → mWh (`kWh * 1_000_000`). Negatief vermogen is teruglevering; de meterstanden import en export blijven aparte cumulatieve tellers.
