# Piano di Azione - Fix Nuxt Content Database Refresh

Abbiamo identificato diversi problemi nell'attuale implementazione della funzionalità di refresh del database, sia in produzione che in sviluppo.

## Problemi Identificati e Soluzioni Portate

### 1. Produzione: Refresh del Server senza Riavvio
Il server di produzione ora è in grado di rilevare aggiornamenti al database e al manifest senza essere riavviato.
- **Soluzione**: Modificato `src/runtime/internal/manifest.ts` per implementare una logica di re-validation del manifest basata sull' `mtime` del file `.data/content/manifest.json`. Ad ogni richiesta, se il file su disco è più recente della versione in memoria, viene ricaricato.
- **Integrità del Database**: In `src/runtime/internal/database.server.ts`, il server confronta il checksum del manifest con quello salvato nella tabella `info` del database. Se c'è una discrepanza, applica chirurgicamente le query del dump SQL per sincronizzare il database senza doverlo ricreare da zero (se la struttura è identica).

### 2. Sviluppo: Fix Cache e Correttezza Asincrona
- **Correzione Cache**: Sistemato l'ordine dei parametri in `db.insertDevelopmentCache` in `src/utils/dev.ts` che causava la corruzione della cache di sviluppo.
- **Operazioni Asincrone**: Aggiunti `await` mancanti in `src/utils/database.ts` e `src/utils/processor.ts` per garantire che le operazioni sul database siano completate prima di procedere.
- **Runtime Fix**: Risolto un `ReferenceError` per la variabile `tables` in `waitUntilDatabaseIsReady`.

## Piano per il Ripristino dell'HMR (Live Reload) in Sviluppo

Il ricaricamento automatico della pagina (HMR) in modalità di sviluppo smesso di funzionare. Dobbiamo ripristinarlo garantendo che conviva con le nuove funzionalità di produzione.

### Problema HMR
Attualmente in `src/runtime/plugins/websocket.dev.ts`, il client riceve le query SQL via websocket e le applica al database locale (browser), chiamando poi `refreshNuxtData()`. Tuttavia, questo non sembra scatenare il ricaricamento della pagina o l'aggiornamento dei componenti in modo affidabile come faceva il commit `06c84f5`.

### Strategia di Ripristino
1. **Verifica della ricezione degli eventi**: Assicurarsi che `server.ws.send` stia effettivamente inviando i dati e che il client li riceva.
2. **Ottimizzazione del ricaricamento**: In Nuxt Content v2/v3, l'HMR del contenuto spesso si affida al plugin Vite per invalidare i moduli o inviare segnali di refresh. 
3. **Sincronizzazione Manifest**: In `src/utils/dev.ts`, l'attesa di `updateTemplates` è corretta, ma dobbiamo assicurarci che il client ricarichi anche il manifest se necessario, o che `refreshNuxtData` sia sufficiente.
4. **Ripristino comportamento originale**: Il commit `06c84f5` usava `refreshNuxtData()` ma forse la catena di eventi era diversa. Verificheremo se `import.meta.hot.accept` o simili sono necessari.

## Evoluzione verso il "Real HMR" (Live Reload senza refresh)

Inizialmente abbiamo ripristinato la funzionalità di sviluppo usando un `full-reload` della pagina. Questo è stato poi evoluto in un sistema di HMR fluido ("Real HMR") che aggiorna i dati senza ricaricare la pagina.

### Sincronizzazione dei Checksum via WebSocket
Per fare in modo che `refreshNuxtData()` funzioni correttamente senza un ricaricamento completo:
1.  **Payload WebSocket Potenziato**: In `src/utils/dev.ts`, il server ora invia i nuovi `checksums` e `checksumsStructure` insieme alle query SQL nel messaggio `nuxt-content:update`.
2.  **Aggiornamento Manifest Preventivo**: Il client riceve questi dati e aggiorna immediatamente il suo `runtimeManifest` interno prima di scatenare il refresh.
3.  **Bypass della Cache**: Poiché il manifest è aggiornato, le nuove richieste di fetch effettuate da `refreshNuxtData()` contengono i parametri di versione corretti, garantendo che il server Nitro restituisca i dati appena salvati nel database.

Questo approccio elimina il "blink" del ricaricamento pagina, mantenendo lo stato della UI (es. posizione dello scroll, input nei form) pur riflettendo istantaneamente le modifiche ai contenuti.
