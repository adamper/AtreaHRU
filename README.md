# Homebridge ATREA Plugin

Homebridge plugin pro ovládání ATREA vzduchotechnických jednotek (HRU - Heat Recovery Units) přes Modbus TCP protokol v Apple HomeKit.

## 🏠 Funkce

- **HomeKit integrace**: Ovládání ATREA jednotky přímo z aplikace Domácnost nebo Siri
- **Modbus TCP**: Spolehlivá komunikace přes Modbus protokol
- **Robustní připojení**: Automatické znovupřipojení s ochranou proti duplicitním připojením
- **"Device Busy" ochrana**: Pokročilé řešení přetížení zařízení s exponential backoff
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

### Optimalizovaná konfigurace (doporučeno pro v2.0+)

**🚨 Nová doporučená konfigurace** pro řešení "device busy" problémů:

```json
{
  "platforms": [
    {
      "name": "Rekuperace",
      "ip": "192.168.0.20",
      "port": 502,
      "regimeRegister": 1001,
      "speedRegister": 1004,
      "connectionTimeout": 15000,
      "operationThrottle": 2500,
      "maxRetries": 2,
      "heartbeatInterval": 120000,
      "cacheTimeout": 8000,
      "logLevel": "info",
      "platform": "AtreaHRU"
    }
  ]
}
```

### Základní konfigurace (minimální)

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

### Konzervativní konfigurace (pro starší/pomalé jednotky)

```json
{
  "platforms": [
    {
      "name": "Rekuperace",
      "ip": "192.168.1.100",
      "port": 502,
      "regimeRegister": 1001,
      "speedRegister": 1004,
      "connectionTimeout": 20000,
      "operationThrottle": 4000,
      "maxRetries": 1,
      "heartbeatInterval": 300000,
      "cacheTimeout": 15000,
      "platform": "AtreaHRU"
    }
  ]
}
```

## 📖 Parametry konfigurace

| Parametr | Typ | Povinný | Výchozí v2.0+ | Starý výchozí | Popis |
|----------|-----|---------|----------------|---------------|-------|
| `name` | string | ✅ | - | - | Název zařízení v HomeKit |
| `ip` | string | ✅ | - | - | IP adresa ATREA jednotky |
| `port` | number | ❌ | 502 | 502 | Modbus TCP port |
| `regimeRegister` | number | ❌ | 1000 | 1000 | Registr pro režim (on/off) |
| `speedRegister` | number | ❌ | 1001 | 1001 | Registr pro rychlost ventilátoru |
| `connectionTimeout` | number | ❌ | **15000** | 10000 | Timeout připojení (ms) |
| `operationThrottle` | number | ❌ | **2500** | 1000 | Zpoždění mezi operacemi (ms) |
| `maxRetries` | number | ❌ | **2** | 3 | Maximální počet opakování |
| `heartbeatInterval` | number | ❌ | **120000** | 60000 | Interval kontroly připojení (ms) |
| `cacheTimeout` | number | ❌ | **8000** | 3000 | Doba platnosti cache (ms) |
| `logLevel` | string | ❌ | info | info | Úroveň logování (error/warn/info/debug) |
| `platform` | string | ✅ | - | - | Musí být "AtreaHRU" |

**⚠️ Poznámka:** Tučně označené hodnoty jsou nové optimalizované výchozí hodnoty ve verzi 2.0+ pro lepší stabilitu.

## 🎯 Příklady konfigurací pro konkrétní modely

### ATREA DUPLEX 370 EC5

```json
{
  "name": "ATREA DUPLEX 370",
  "ip": "192.168.0.20",
  "port": 502,
  "regimeRegister": 1001,
  "speedRegister": 1004,
  "connectionTimeout": 15000,
  "operationThrottle": 2500,
  "platform": "AtreaHRU"
}
```

### ATREA DUPLEX ECV5 (rychlejší jednotka)

```json
{
  "name": "ATREA ECV5",
  "ip": "192.168.1.50",
  "port": 502,
  "regimeRegister": 1000,
  "speedRegister": 1001,
  "connectionTimeout": 12000,
  "operationThrottle": 2000,
  "heartbeatInterval": 90000,
  "platform": "AtreaHRU"
}
```

### ATREA RD5 (starší model)

```json
{
  "name": "ATREA RD5",
  "ip": "192.168.1.100",
  "port": 502,
  "regimeRegister": 1001,
  "speedRegister": 1004,
  "connectionTimeout": 20000,
  "operationThrottle": 4000,
  "maxRetries": 1,
  "heartbeatInterval": 180000,
  "platform": "AtreaHRU"
}
```

## 🔍 Zjištění registrů

Pokud nevíte, které registry používá vaše ATREA jednotka:

1. **Zkuste výchozí hodnoty** (regimeRegister: 1001, speedRegister: 1004)
2. **Běžné hodnoty pro ATREA:**
   - **Duplex EC5/ECV5**: Regime=1001, Speed=1004
   - **RD5**: Regime=1000, Speed=1001  
   - **Starší modely**: Regime=40001, Speed=40002
3. **Konzultujte dokumentaci** k vaší konkrétní jednotce
4. **Kontaktujte podporu ATREA** pro Modbus mapu registrů
5. **Použijte Modbus explorer** pro testování registrů

## 🚨 Řešení problémů

### ⚡ "Device Busy" chyby (Modbus Exception 6)

**Nejčastější problém**: Jednotka hlásí "Slave device busy"

**Řešení:**
1. **Použijte optimalizovanou konfiguraci** (viz výše)
2. **Zvyšte throttling:**
   ```json
   {
     "operationThrottle": 3000,
     "connectionTimeout": 20000
   }
   ```
3. **Snižte heartbeat:**
   ```json
   {
     "heartbeatInterval": 300000
   }
   ```

**Plugin v2.0+ automaticky:**
- Detekuje "device busy" chyby
- Aplikuje exponential backoff (3-15 sekund)
- Opakuje operace s postupně delšími intervaly
- Loguje pokusy pro diagnostiku

### Plugin se nemůže připojit

1. **Zkontrolujte síťové připojení:**
   ```bash
   ping 192.168.0.20
   telnet 192.168.0.20 502
   ```

2. **Ověřte nastavení ATREA jednotky:**
   - Zkontrolujte IP konfiguraci na displeji
   - Ujistěte se, že je Modbus TCP povolen
   - Zkontrolujte firewall nastavení

3. **Zvyšte timeout hodnoty:**
   ```json
   {
     "connectionTimeout": 25000,
     "operationThrottle": 5000
   }
   ```

### Duplicitní připojení

Plugin automaticky detekuje a řeší duplicitní připojení. V logu uvidíte:

```
CRITICAL: Duplicate connection detected for 192.168.0.20:502!
```

**Řešení:** Plugin se o cleanup postará automaticky. Pokud problém přetrvává:
1. Restartujte Homebridge
2. Zkontrolujte, že nemáte více instancí platformy v config.json

### Pomalá odezva

1. **Optimalizujte cache:**
   ```json
   {
     "cacheTimeout": 10000,
     "operationThrottle": 2000
   }
   ```

2. **Snižte heartbeat (opatrně):**
   ```json
   {
     "heartbeatInterval": 90000
   }
   ```

⚠️ **Pozor:** Příliš agresivní nastavení může způsobit "device busy" chyby!

### Chyby registrů

```
Error: Invalid register value
```

**Řešení:**
1. Použijte debug logování: `"logLevel": "debug"`
2. Vyzkoušejte různé hodnoty registrů
3. Zkontrolujte dokumentaci vaší jednotky
4. Testujte postupně: nejdřív regime registr, pak speed

## 📊 Diagnostika a monitoring

### Debug logování

```json
{
  "logLevel": "debug"
}
```

Plugin zobrazí detailní informace o:
- 🔗 Stavu připojení a reconnect pokusech
- 📊 Úspěšnosti operací a cache hit rate
- ⚡ "Device busy" detekci a backoff časech
- 🏥 Zdraví platformy a anomáliích
- 📈 Statistikách výkonu

### Health check monitoring

Plugin automaticky monitoruje:
- **Connection health**: Úspěšnost připojení
- **Operation success rate**: Procento úspěšných operací
- **Device busy events**: Počet a frekvence přetížení
- **Cache efficiency**: Efektivita vyrovnávací paměti

## 🔄 Migrace z verze 1.x na 2.0+

1. **Zálohujte** stávající config.json
2. **Aktualizujte** hodnoty konfigurace:
   ```json
   {
     "connectionTimeout": 15000,    // bylo 10000
     "operationThrottle": 2500,     // bylo 1000  
     "maxRetries": 2,               // bylo 3
     "heartbeatInterval": 120000,   // bylo 60000
     "cacheTimeout": 8000          // bylo 3000
   }
   ```
3. **Restartujte** Homebridge
4. **Sledujte logy** pro případné "device busy" chyby

## 📄 Licence

Tento projekt je licencován pod MIT licencí - viz [LICENSE](LICENSE) soubor.

## 🤝 Podpora

- **GitHub Issues**: Pro bug reporty a feature requesty
- **Homebridge Discord**: Pro obecnou podporu
- **ATREA Support**: Pro technické dotazy ohledně Modbus registrů

## 📈 Changelog

### v2.0.0 🎉
- ✨ **Pokročilé řešení "device busy" chyb** s exponential backoff
- 🔧 **Optimalizované výchozí hodnoty** pro stabilnější komunikaci
- 🛡️ **Vylepšené error handling** a automatické zotavení
- 📊 **Pokročilá diagnostika** a health monitoring
- 🚀 **Lepší performance** s vylepšeným cachingem
- 🔄 **Robustní ochrana** proti duplicitním připojením

### v1.0.0
- 🎉 Prvotní release
- 🏠 Základní HomeKit integrace
- 📡 Modbus TCP komunikace

---

## 🛠️ Rychlý troubleshooting checklist

**Při problémech zkuste v tomto pořadí:**

1. ✅ **Zkontrolujte síť**: ping + telnet test
2. ✅ **Použijte optimalizovanou config** (viz výše)
3. ✅ **Zapněte debug logování**: `"logLevel": "debug"`
4. ✅ **Restartujte Homebridge**
5. ✅ **Zvyšte throttling** pokud vidíte "device busy"
6. ✅ **Kontaktujte podporu** s debug logy