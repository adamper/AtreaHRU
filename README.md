# Homebridge ATREA Plugin

Homebridge plugin pro ovládání ATREA vzduchotechnických jednotek (HRU - Heat Recovery Units) přes Modbus TCP protokol v Apple HomeKit.

## 🏠 Funkce

- **HomeKit integrace**: Ovládání ATREA jednotky přímo z aplikace Domácnost nebo Siri
- **Modbus TCP**: Spolehlivá komunikace přes Modbus protokol
- **Robustní připojení**: Automatické znovupřipojení s ochranou proti duplicitním připojením
- **Vyrovnávací paměť**: Inteligentní cachování pro rychlejší odezvu
- **Diagnostika**: Pokročilé monitorování stavu připojení
- **Fan Control**: Zapínání/vypínání a nastavení rychlosti ventilátoru

## 📋 Požadavky

- [Homebridge](https://homebridge.io/) v1.6.0 nebo novější
- Node.js v16 nebo novější
- ATREA vzduchotechnická jednotka s Modbus TCP rozhraním
- Síťové připojení k jednotce

## 🔧 Instalace

### Přes Homebridge UI (doporučeno)

1. Otevřete Homebridge Config UI X
2. Přejděte na záložku "Plugins"
3. Vyhledejte "homebridge-atrea"
4. Klikněte na "Install"

### Přes terminál

```bash
npm install -g homebridge-atrea
```

## ⚙️ Konfigurace

### Základní konfigurace

Přidejte následující konfiguraci do vašeho `config.json` souboru v sekci `platforms`:

```json
{
  "platforms": [
    {
      "name": "Rekuperace",
      "ip": "192.168.1.100",
      "port": 502,
      "regimeRegister": 1001,
      "speedRegister": 1004,
      "platform": "AtreaHRU"
    }
  ]
}
```

### Kompletní konfigurace

```json
{
  "platforms": [
    {
      "name": "Rekuperace",
      "ip": "192.168.1.100",
      "port": 502,
      "regimeRegister": 1001,
      "speedRegister": 1004,
      "connectionTimeout": 5000,
      "operationThrottle": 800,
      "maxRetries": 3,
      "heartbeatInterval": 45000,
      "cacheTimeout": 3000,
      "logLevel": "info",
      "platform": "AtreaHRU"
    }
  ]
}
```

## 📖 Parametry konfigurace

| Parametr | Typ | Povinný | Výchozí | Popis |
|----------|-----|---------|---------|-------|
| `name` | string | ✅ | - | Název zařízení v HomeKit |
| `ip` | string | ✅ | - | IP adresa ATREA jednotky |
| `port` | number | ❌ | 502 | Modbus TCP port |
| `regimeRegister` | number | ❌ | 1000 | Registr pro režim (on/off) |
| `speedRegister` | number | ❌ | 1001 | Registr pro rychlost ventilátoru |
| `connectionTimeout` | number | ❌ | 10000 | Timeout připojení (ms) |
| `operationThrottle` | number | ❌ | 1000 | Zpoždění mezi operacemi (ms) |
| `maxRetries` | number | ❌ | 3 | Maximální počet opakování |
| `heartbeatInterval` | number | ❌ | 60000 | Interval kontroly připojení (ms) |
| `cacheTimeout` | number | ❌ | 3000 | Doba platnosti cache (ms) |
| `logLevel` | string | ❌ | info | Úroveň logování (error/warn/info/debug) |
| `platform` | string | ✅ | - | Musí být "AtreaHRU" |

## 🎯 Příklady konfigurací

### ATREA DUPLEX 370 EC5

```json
{
  "name": "ATREA DUPLEX 370",
  "ip": "192.168.0.20",
  "port": 502,
  "regimeRegister": 1001,
  "speedRegister": 1004,
  "platform": "AtreaHRU"
}
```

### ATREA DUPLEX ECV5 (rychlá odezva)

```json
{
  "name": "ATREA ECV5",
  "ip": "192.168.1.50",
  "port": 502,
  "regimeRegister": 1000,
  "speedRegister": 1001,
  "connectionTimeout": 3000,
  "operationThrottle": 500,
  "heartbeatInterval": 30000,
  "platform": "AtreaHRU"
}
```

### Stabilní konfigurace pro starší jednotky

```json
{
  "name": "ATREA Legacy",
  "ip": "192.168.1.100",
  "port": 502,
  "regimeRegister": 1001,
  "speedRegister": 1004,
  "connectionTimeout": 8000,
  "operationThrottle": 2000,
  "maxRetries": 5,
  "heartbeatInterval": 90000,
  "platform": "AtreaHRU"
}
```

## 🔍 Zjištění registrů

Pokud nevíte, které registry používá vaše ATREA jednotka:

1. **Zkuste výchozí hodnoty** (regimeRegister: 1001, speedRegister: 1004)
2. **Konzultujte dokumentaci** k vaší konkrétní jednotce
3. **Kontaktujte podporu ATREA** pro Modbus mapu registrů
4. **Použijte Modbus explorer** pro testování registrů

Běžné hodnoty:
- **Regime Register**: 1000, 1001, 40001
- **Speed Register**: 1001, 1004, 40002

## 🚨 Řešení problémů

### Plugin se nemůže připojit

1. **Zkontrolujte IP adresu a port**
   ```bash
   ping 192.168.1.100
   telnet 192.168.1.100 502
   ```

2. **Ověřte síťové nastavení ATREA jednotky**
   - Zkontrolujte IP konfiguraci na displeji jednotky
   - Ujistěte se, že je Modbus TCP povolen

3. **Zvyšte timeout hodnoty**
   ```json
   {
     "connectionTimeout": 15000,
     "operationThrottle": 2000
   }
   ```

### Duplicitní připojení

Plugin automaticky detekuje a řeší duplicitní připojení. Pokud vidíte v logu:

```
CRITICAL: Duplicate connection detected for 192.168.1.100:502!
```

Plugin automaticky vyčistí duplicitní instance. Restart Homebridge může pomoci.

### Pomalá odezva

1. **Snižte throttling**
   ```json
   {
     "operationThrottle": 500,
     "cacheTimeout": 5000
   }
   ```

2. **Snižte heartbeat interval**
   ```json
   {
     "heartbeatInterval": 30000
   }
   ```

### Chyby registrů

```
Error: Invalid register value
```

- Zkontrolujte dokumentaci vaší ATREA jednotky
- Vyzkoušejte různé hodnoty registrů
- Použijte debug logování: `"logLevel": "debug"`

## 📊 Diagnostika

Pro zobrazení diagnostických informací nastavte:

```json
{
  "logLevel": "debug"
}
```

Plugin poskytuje detailní informace o:
- Stavu připojení
- Úspěšnosti operací
- Cache statistikách
- Zdraví platformy

## 📄 Licence

Tento projekt je licencován pod MIT licencí - viz [LICENSE](LICENSE) soubor.

## 📈 Changelog

### v2.0.0
- ✨ Robustní ochrana proti duplicitním připojením
- 🔧 Vylepšená správa cache a throttling
- 📊 Pokročilá diagnostika a monitoring
- 🛡️ Vylepšené error handling a recovery

### v1.0.0
- 🎉 Prvotní release
- 🏠 Základní HomeKit integrace
- 📡 Modbus TCP komunikace