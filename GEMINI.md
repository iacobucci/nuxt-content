# Piano di Azione - Fix Nuxt Content Database Refresh

Abbiamo identificato diversi problemi nell'attuale implementazione della funzionalità di refresh del database, sia in produzione che in sviluppo.

## Problemi Identificati

1.  **Cache del Manifest in Produzione:** Il server di produzione non rileva gli aggiornamenti del file `.data/content/manifest.json` dopo il primo caricamento a causa di un bug nella funzione `useRuntimeManifest` che restituisce sempre la versione in memoria se già presente.
2.  **HMR in Sviluppo (Dev Mode):**
    -   Scambio di argomenti nella chiamata a `db.insertDevelopmentCache` in `src/utils/dev.ts`, che corrompe la cache di sviluppo.
    -   Possibile race condition tra l'aggiornamento dei template di Nuxt (manifest) e la notifica HMR inviata al client.
3.  **Bug di Runtime:**
    -   Riferimento mancante a `tables` nella funzione `waitUntilDatabaseIsReady` in `src/runtime/internal/database.server.ts`.
    -   `updateTemplates` non è atteso nel watcher di sviluppo.

## Soluzioni Proposte

### 1. Produzione: Fix `useRuntimeManifest`
Modificare `src/runtime/internal/manifest.ts` per controllare sempre l' `mtime` del file del manifest su disco anche se una versione è già stata caricata in memoria. In questo modo, se `pnpm exec nuxt-content` aggiorna il file, il server lo caricherà alla richiesta successiva.

### 2. Sviluppo: Fix HMR e Cache
-   Correggere l'ordine degli argomenti in `src/utils/dev.ts`: `db.insertDevelopmentCache(keyInCollection, parsedContent, checksum)`.
-   Attendere `updateTemplates` in `src/utils/dev.ts` prima di inviare la notifica HMR via websocket, per garantire che il client riceva i nuovi checksum quando interroga il manifest.

### 3. Fix Bug di Runtime
-   Passare o recuperare correttamente `tables` in `waitUntilDatabaseIsReady`.
-   Assicurarsi che tutte le operazioni asincrone siano gestite correttamente.

## Passaggi Operativi

1.  **Modifica `src/runtime/internal/manifest.ts`**: Implementare la logica di re-validation del file manifest basata su `mtime`.
2.  **Modifica `src/utils/dev.ts`**:
    -   Sistemare la chiamata a `insertDevelopmentCache`.
    -   Rendere `broadcast` asincrono (già lo è) e assicurarsi di attendere `updateTemplates`.
3.  **Modifica `src/runtime/internal/database.server.ts`**: Fix del riferimento a `tables`.
4.  **Test**: Verificare il funzionamento in dev e simulare il comportamento in produzione.
