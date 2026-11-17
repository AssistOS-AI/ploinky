# Noua structură a `.data`: agents / robots / dpu-data

Plan de implementare în 4 pași.

## Stare (2026-11-16)

| Pas | Stare |
| --- | --- |
| 1. `.data/agents` și izolarea agenților | Implementat și testat (unit + pornire reală). Necomis, pe ramura `feat/data-layout` în ploinky și în AssistOSExplorer. |
| 2. `.data/robots` și eliminarea `.private` | Implementat și testat local, inclusiv migrare reală și pornire în `ploinky-test`. Necomis, pe `feat/data-layout` în ambele repo-uri. |
| 3. dpuAgent și master key | Implementat și testat, inclusiv migrare offline și pornire reală în `ploinky-test`. Necomis. |
| 4. Agenții pe `/root`, explorer vede `.data` prin dpuAgent | Implementat și testat prin unitare, integrarea providerului Explorer cu DPU și probe în containere. Necomis. |

## Cerința (cuvintele utilizatorului)

Cererea inițială, 2026-11-13, citată exact:

> vreau sa facem o refactorizare majora la cum tin agentii datele lor, acum exista .data in workspaceul ploinky si fiecare agent are un folder acolo, si mai exista si un .private care se paote pune ca "privat" pentru agenti. vreau sa nu mai existe acest .private pentru ca nu va mai fi nevoie. deocamdata doar /home/mircea/Desktop/work/AssistOSExplorer/roboWorkAgent il foloseste si ploinky pentru credentialele git de la robotul default. vreau ca datele robotilor sa fie mutate, zic imeiat unde, acolo sa fie homeurile lor si credentialele de git ale lor. cat despre credentialele de git a robotului default vor fi tinute separat. vreau ca in loc sa avem .data/nume agent vom avea .data/robots - aici vor fi homeurile robotilor si credentialele lor, ./data/agents in care vor fi toate folderele care se afla acum in ./data (mai putin .private ca l stergem) si .data/dpu-data datele lui dpuAgent. deci ramane regula ca fiecare agent are un folder de date propriu dar trebuie sa fie privat si sa fie in .data/agents/nume . agentul dpuAgent este tratat special, folderul sau de date va fi chiar .data, el se va ocupa de accesul la foldere, trebuie ca agentii de ploinky sa aiba acees doar la homeul lor privat (.data/agents/nume), userii admin in explorer sa vada tot .data, userii normali sa poata vedea in interfata explorer doar (.data/agents/explorer). Robowork va avea o exceptie, va declara prin manifest.json ca cere access la roboti, ca sa poata sa i managerieze si ii se va monta in container si .data/robots/ . credentialele de git ale userilor se tin in dpuAgent din ce stiu, adica vor fi in .data/dpu-data , la fel si credentialele robotului default (cel care l foloseste ploinky acum pentru ploinky update). Ploinky master key sta acum in .ploinky/data, trebuie mutat sa stea in .data/dpu-data si el. deci trebuie modificat codul sa avem acest feature si trebuie facut si cod de migrare astfel incat sa mutam .data in .data/agents/ si cheia master, si credentialele git. fa un plan mai intai. imparte tot acest mare feature in 2-3 etape de implementare, sa nu faci totul dintr o bucata. n ar trebui sa se modifice agentii de ploinky deloc, doar la robowork manifest.json .

Precizări ulterioare (2026-11-16), rezumate:
- modificările în agenți sunt acceptate (ultima frază din cererea inițială nu mai e valabilă);
- dpuAgent poate vedea master key-ul: el se ocupă de criptare, e managerul datelor private/secrete;
- accesul special se declară prin `volumes` în manifest, fără listă de permisiuni;
- tot ce ține de roboți stă în `.data/robots`;
- fiecare agent își primește automat folderul privat la `/root`; nu declară nimic;
- opțiunea cu `/data` se ignoră; agenții sunt modificați să-și folosească datele din `/root`, care e același lucru.

## Rezultatul dorit și de ce

| Cerință | De ce |
| --- | --- |
| **dpuAgent este „ownerul” lui `.data`.** Vede tot `.data` și mediază accesul la el (inclusiv ce văd userii în explorer). | E managerul datelor private și secrete; accesul la date trece printr-un singur agent, cu regulile și auditul lui. |
| **Datele proprii ale dpuAgent stau în `.data/dpu-data`**, separat de `.data/agents`. | dpuAgent e special: datele lui (secrete, tokenuri git ale userilor, credențialele robotului default, master key) nu sunt datele unui agent obișnuit. |
| **Fiecare agent ploinky își vede doar folderul privat, `.data/agents/<nume>`**, primit automat, fără declarație în manifest. | Azi agenții globali văd `.data`-ul tuturor; un agent nu trebuie să poată citi datele altuia. |
| **Roboții stau separat, în `.data/robots`** (home-uri, rulări, credențiale), **accesibili doar lui roboWorkAgent**, care îi declară prin `volumes`. | Roboții nu sunt agenți; doar roboWork îi gestionează. Credențialele lor nu trebuie să fie la îndemâna altor agenți. |
| **Credențialele git ale robotului default stau separat, în `.data/dpu-data`.** | Le folosește ploinky (`ploinky update`), nu robotul; țin de zona administrată de dpuAgent. |
| **Master key-ul ploinky stă în `.data/dpu-data`** (mutat din `.ploinky/data`). | Toate secretele workspace-ului stau în zona lui dpuAgent; dpuAgent are voie să-l vadă. |
| **`.data/.private` dispare.** | Era o soluție punctuală pentru roboWork și pentru credențialele default; noua structură le acoperă. |
| **Fără `/data`: agenții își folosesc datele din `/root`.** Agenții noștri se modifică în consecință. | `/root` e deja folderul privat al fiecărui agent; un al doilea punct de montare pentru aceleași date e redundant. |
| **Adminii văd tot `.data` în explorer; userii normali doar `.data/agents/explorer`.** | Adminii administrează workspace-ul; userii normali au nevoie doar de datele explorer. |
| **Migrare automată** a structurii vechi: folderele agenților, robotii, credențialele git, master key-ul. | Workspace-urile existente trebuie să treacă pe structura nouă fără pași manuali și fără pierderi de date. |
| **Implementare în etape**, nu dintr-o bucată. | Fiecare etapă se testează separat. |

## Obiectiv

Azi fiecare agent are `.data/<nume>`, montat ca home la `/root`. Agenții globali (explorer, dpuAgent, gitAgent, roboTeamAgent, roboWorkAgent) văd însă tot workspace-ul, deci și `.data`-ul celorlalți. Singura excepție este `.data/.private`, ascuns printr-un mount gol (`cli/utils/runtime/controllerStateGuards.js`) și folosit doar de roboWorkAgent și de credențialele git ale robotului default.

Structura finală:

```
.data/
├── agents/<instanta>/   home-ul privat al fiecărui agent, montat la /root (fostele .data/<x>)
│   └── shared/          fostul .data/shared, montat în continuare la /shared
├── robots/              tot ce ține de roboți (montat în roboWork la /robots)
│   ├── <robotId>/home | run | runs/<runId> | terminal
│   └── .credentials/<robotId>.json
└── dpu-data/            datele dpuAgent (secrets.json cu tokenurile git ale userilor etc.)
    ├── master-key       master key-ul ploinky (mutat din .ploinky/data/master-key)
    └── git-credentials/ credențialele git ale robotului default (folosite de ploinky update)
```

`.data/.private` dispare complet.

## Reguli stabilite

1. **Orice agent primește automat `.data/agents/<instanta>` montat la `/root`.** Nu trebuie declarat nimic în manifest. Un alias primește folderul aliasului, ca acum.
2. **dpuAgent are ca folder de date `.data/dpu-data`, montat la `/root` ca la orice agent, și vede în plus tot `.data` la `/workspace-data`.** Declarația din manifest: `"volumes": { ".data/dpu-data": "/root", ".data": "/workspace-data" }`. Un volum cu destinația `/root` înlocuiește home-ul implicit. `dpu-data` apare și la `/root`, și la `/workspace-data/dpu-data`: sunt aceleași fișiere. (Varianta „b”, aleasă 2026-11-16; `/data` nu se folosește. Numele `/workspace-data` se poate schimba.)
3. **roboWorkAgent declară în plus `"volumes": { ".data/robots": "/robots" }`.** Home-ul lui (`/root`) este `.data/agents/roboWorkAgent`. Acolo rămâne doar starea serviciului: `tool-cache`, `server-state`, `proxy-pool` și catalogul de modele.
4. **Nu există listă de permisiuni.** Declarațiile din manifest sunt suficiente. S-a acceptat că orice manifest le poate declara.
5. **Agenții își citesc datele din `/root`, nu din `/data`.** Agenții pe care îi controlăm se modifică. Volumele existente `.data/<x>/...` continuă să funcționeze: ploinky le traduce transparent în `.data/agents/<x>/...`. Fac excepție `agents`, `robots` și `dpu-data`, care nu se traduc. La cererea ulterioară a utilizatorului, `persistentStorage` și template-urile `STORAGE_CONTAINER_PATH`/`STORAGE_HOST_PATH` au fost eliminate; configurațiile vechi sunt refuzate cu îndrumare spre home-ul automat sau `volumes`.
6. **Pentru agenții globali, `<ws>/.data` este ascuns în container.** Rămân vizibile doar:
   - home-ul propriu;
   - volumele declarate;
   - `/shared`;
   - folderul propriu și la calea lui reală din workspace, `<ws>/.data/agents/<nume>` (în interiorul măștii). Explorer, roboTeam, gitAgent și terminalele roboWork își accesează datele prin workspace; au fost mutați pe `.data/agents/<nume>` în pasul 1.
7. **Ce văd userii în explorer:**
   - adminii văd tot `.data`;
   - userii normali văd doar `.data/agents/explorer`;
   - accesul trece prin dpuAgent (pasul 4).

## Migrarea (comună tuturor pașilor)

- Un modul nou, `cli/utils/dataLayoutMigration.js`, conține pași ordonați și idempotenți. Versiunea structurii este notată în `.data/.layout.json`. Nu e nevoie de jurnal separat: fiecare `rename` e atomic, iar o rulare întreruptă continuă cu ce a rămas.
- Din pasul 2, migrarea rulează pe host înainte de crearea Box-ului, sub lock-ul workspace-ului și lock-ul `.data/.layout-migration.lock`. `initEnvironment` nu mai migrează, iar migrarea în Box este refuzată. Versiunea curentă este 4.
- O lansare de agent (`ensureHostLaunchSkeleton`) nu migrează: doar verifică structura și refuză dacă e încă veche, pentru că acolo căile au fost deja calculate.
- Condiția stabilită pentru pasul 2: se execută întâi `ploinky destroy`. Migrarea refuză un Box existent, inclusiv oprit, precum și orice alt runtime activ al workspace-ului. `stop` și `destroy` rămân disponibile pe structura veche. Inițializarea unui workspace nou fără date de mutat rămâne permisă.
- Căile din registrul agenților (`.ploinky/agents.json`: `projectPath`, `config.binds[].source`) sunt rescrise odată cu mutarea.
- Dacă destinația există și nu e goală, se oprește cu eroare. Nu face merge implicit, în afară de cazurile listate explicit mai jos.

---

## Pasul 1: `.data/agents` și izolarea agenților — IMPLEMENTAT

### Ce s-a făcut în ploinky

- **Căi noi** (`cli/utils/config.js`, `cli/utils/workspaceStructure.js`): `DATA_ROOT` = `.data`, `AGENTS_DATA_DIR` = `.data/agents`, `SHARED_DIR` = `.data/agents/shared`. `getAgentWorkDir`/`getAgentDataDir` întorc `.data/agents/<instanta>`.
- **Politica de căi** (`cli/utils/runtime/agentDataPathPolicy.js`):
  - `resolveAgentDataPath` (și varianta async) rezolvă în `.data/agents/<cheie>`;
  - `RESERVED_DATA_ENTRIES` = `agents`, `robots`, `dpu-data`;
  - `translateLegacyDataPath()` mapează `.data/<x>/...` (relativ sau absolut) în `.data/agents/<x>/...`; nu se traduc rădăcina `.data`, intrările rezervate și intrările care încep cu punct (`.private`);
  - `resolveReservedDataPath(name)` pentru stocările de nivel superior;
  - `assertManifestVolumeStoragePolicy` traduce sursele de volum, deci toate manifestele vechi `.data/<x>` funcționează nemodificate.
- **`persistentStorage`** (`runtimeResourcePlanner.js`): cheile rezolvă în `.data/agents/<cheie>`; excepția temporară `dpu-data` rămâne `.data/dpu-data` până la pasul 3.
- **Blob-uri** (`cli/server/handlers/blobs.js`): `.data/agents/<agent>/blobs`, iar `localPath` devine `.data/agents/<agent>/blobs/<id>`.
- **Garda nouă `workspace-data`** (`cli/utils/runtime/controllerStateGuards.js`), pentru tot `.data`:
  - un bind larg care conține `.data` (workspace-ul la agenții globali, agentul static) primește o mască read-only peste `.data`;
  - când lansarea are un home `.data/agents/<nume>`, masca este o „vedere” din afara workspace-ului (`/tmp/ploinky-runtime-guards/<ws>/data-views/<hash>`) care conține doar punctul de montare gol `agents/<nume>`; home-ul agentului e montat peste el, la calea lui reală, writable;
  - bind-urile *de* sau *sub* `.data` (home, volume, storage, `/shared`) sunt granturi explicite, deja validate de politica de căi, și nu mai primesc mască;
  - masca separată pentru `.data/.private` nu se mai emite când e acoperită de masca `.data` (ar fi cerut un punct de montare în interiorul unei măști read-only); garda `private` rămâne pentru verificarea bind-urilor din `.private` până la pasul 2;
  - părintele gărzii (workspace-ul) nu e niciodată fixat read-only.
- **Aplicarea gărzii**: docker/podman (`agentServiceManager.js`, primește `agentDataDir`; fallback-ul din Box nu mai emite masca `.private`), bwrap (`bwrapServiceManager.js`), shell-uri interactive (`interactive.js`, doar mască, fără proiecție). În docker/bwrap, `storageWorkspaceRoot` se calculează acum din `.data/agents/shared` (trei niveluri).
- **Seatbelt** (`seatbeltProfile.js`, macOS, fără namespace-uri): `.data` e interzis la citire/scriere ca restul stării protejate, apoi se re-permit home-ul, `/shared`, volumele writable și storage-ul declarat; volumele read-only primesc doar citire, cu interdicție explicită de scriere.
- **Migrarea** (`cli/utils/dataLayoutMigration.js`, nou):
  - versiunea structurii în `.data/.layout.json` (lipsă = versiunea 1; acum versiunea 2);
  - `ensureDataLayout()` rulează în `initEnvironment()` la fiecare comandă CLI (și în Box), sub lock-ul `.data/.layout-migration.lock` (holder-ul mort de pe același host e recunoscut după pid);
  - mută prin `rename` fiecare intrare `.data/<x>` care arată ca nume de agent și nu e rezervată; un home gol creat devreme la destinație e înlocuit, iar un conflict ne-gol oprește migrarea, fără să scrie versiunea;
  - `.data/agents` trebuie să fie director real (un symlink e refuzat);
  - rescrie căile din `.ploinky/agents.json` (`projectPath`, `config.binds[].source`) și păstrează modul fișierului;
  - o versiune mai nouă decât cea cunoscută e refuzată;
  - `assertDataLayoutCurrent()` rulează la fiecare lansare (`ensureHostLaunchSkeleton`): nu mută nimic; marchează ca actual un workspace fără intrări vechi și refuză unul care încă are structura veche.

### Ce s-a făcut în agenți (AssistOSExplorer)

Agenții care își accesau datele prin calea din workspace au trecut pe `.data/agents/<nume>`:
- explorer: `private-data-boundary.mjs`, `avatar-settings-store.mjs`, `tool-handlers.mjs` (`plugin-settings.json`), `tool-runtime.mjs` (`search-jobs`), `markdown-crdt-store.mjs`, `scripta-crdt-service.mjs`, `webmeet-media-store.mjs` (validarea `localPath`), descrierea din `tool-definitions.mjs`;
- gitAgent: `lib/github-auth.mjs`;
- roboTeamAgent: `server/workspace-paths.mjs`;
- roboWorkAgent: `server/terminal-profiles.mjs`, `scripts/robot-shell.mjs` (terminalele stub);
- testele lor și testele smoke (`tests/smoke/lib/*`); validatorul smoke așteaptă `/data` = `.data/agents/roboTeamAgent` pentru roboTeam și încă `.data/.private/roboWorkAgent` pentru roboWork.

Manifestele nu s-au schimbat (inclusiv `roboTeamAgent`: `".data/roboTeamAgent": "/data"` e tradus automat).

### Abateri față de planul inițial

- **Fără proiecție la calea veche.** Planul prevedea ca home-ul să fie vizibil și la `<ws>/.data/<nume>`. Pe seatbelt nu există namespace-uri, deci calea veche n-ar fi existat; home-ul e expus la calea lui reală `<ws>/.data/agents/<nume>`, iar agenții care o foloseau au fost actualizați încă din pasul 1.
- **Migrarea nu refuză containerele pornite.** `rename` păstrează inode-ul, deci bind-urile containerelor pornite continuă să scrie în același folder; ele văd căile noi abia la repornire.
- **Lansarea nu migrează.** O primă variantă migra și din `ensureHostLaunchSkeleton`; testele bwrap reale au arătat că astfel folderul se muta după ce căile lansării fuseseră calculate. Acum lansarea doar verifică.
- **Fără jurnal de migrare.** Starea de pe disc e jurnalul: fiecare `rename` e atomic, iar o rulare întreruptă continuă cu ce a rămas.
- **Registrul agenților.** Nu era în plan: `agents.json` păstra `projectPath`/bind-urile vechi, iar lansările (bwrap, pornirile pregătite) le refuzau sau le detectau ca schimbări. Migrarea le rescrie.
- **Bind-ul explicit al întregului `.data`** e permis (ca înainte în politică); va fi necesar pentru dpuAgent în pasul 3.
- **Specificațiile DS nu au fost modificate**, conform `AGENTS.md` (codul și testele sunt sursa adevărului; DS-urile nu se actualizează ca parte a modificărilor de comportament).

### Teste

**Unit, ploinky.** `tests/unit/dataLayoutMigration.test.mjs` (nou, 9 teste):
- workspace nou → versiunea 2 fără mutări;
- mutare din structura plată, cu păstrarea `dpu-data`, `.private` și a symlink-urilor, verificarea inode-ului și idempotență;
- rescrierea registrului și păstrarea modului fișierului;
- home gol înlocuit, conflict ne-gol care oprește migrarea;
- `.data/agents` symlink refuzat;
- lansare refuzată pe structura veche, iar workspace-ul curat marcat actual;
- versiune mai nouă refuzată;
- planificatorul de gărzi: vederea conține doar `agents/<nume>`, proiecția e writable, fără mască `.private`, vederea e refolosită;
- bind-urile de/sub `.data` nu primesc mască.

Testele existente au fost actualizate la căile noi (fixture-uri `.data/<x>` → `.data/agents/<x>`, `.data/shared` → `.data/agents/shared`, așteptări noi pentru mască): `agentDataPathPolicy`, `blobDownloadAsync`, `bwrapAliasFirstInstance`, `bwrapArgs`, `bwrapAttachInteractive`, `bwrapCodeMountPoints`, `bwrapStaticHomeLayout` (bwrap real: agentul static vede `/root/.data/agents/<nume>`), `containerRuntime`, `controllerSecretsPodmanMounts`, `dependencyStore*`, `managedContainerLabels`, `nativeGraphPredecessor`, `podmanStaging`, `privateDataMask`, `repositoryWorkspaceMounts`, `seatbeltProfile`, `uploadAdmission`, `workspaceFileProtection`, `agentServiceManager`, `agentlibCacheLink`.

**Suita unitară completă** (686 de fișiere), comparată cu `HEAD` rulat într-un worktree separat: niciun eșec nou. Eșecurile rămase există identic pe `HEAD`: teste git care cer rețea (`branchAwareStart`), permisiuni ale mediului local („Host state directory has unsafe write permissions”) și câteva teste instabile.

**Unit, AssistOSExplorer.** Testele unitare explorer și gitAgent, plus fișierele roboWork, roboTeam și smoke modificate, comparate cu `main`: niciun eșec nou. Cele 9 eșecuri explorer rămase (axiFace, docs, SSO, toolbar, hardware limits) pică identic pe `main`.

**Pornire reală, de la zero.** `ploinky start explorer 8090` în `~/Desktop/ploinky-test`, cu o copie a ramurii AssistOSExplorer în workspace ca sursă de agenți:
- toți cei 10 agenți `[running]`: dpuAgent, emailAgent, gitAgent, userPersistoAgent, explorer, soul-gateway, workspaceMonitorAgent, local-llm, roboWorkAgent, roboTeamAgent; routerul răspunde;
- `.data` conține `.layout.json` (versiunea 2), `agents/` (toți agenții plus `shared`, `workspace-monitor`), `dpu-data/` și `.private/`;
- în explorer, gitAgent, dpuAgent, roboWorkAgent și roboTeamAgent: `ls <ws>/.data` arată doar `agents`, iar `ls <ws>/.data/agents` doar folderul propriu; scrierea în `.data/agents` dă „Read-only file system”; folderul propriu are același conținut la `/root` și la calea reală;
- montări: dpuAgent `/dpu-data` ← `.data/dpu-data`; roboTeam `/data` ← `.data/agents/roboTeamAgent` (volum vechi tradus); userPersistoAgent `/data` ← `.data/agents/userPersistoAgent`; roboWork `/data` ← `.data/.private/roboWorkAgent` și `/git-credentials` ← `.data/.private/.git-credentials` (neschimbate până la pasul 2);
- log-uri: fără erori, în afară de un `ECONNREFUSED :3001` tranzitoriu la pornirea roboWork; apoi serviciul răspunde, robotul default e creat și rulările se listează.

**Neverificat încă:**
- interfața explorer în browser (setări plugin, avatar, documente CRDT, blob-uri WebMeet);
- terminalul unui robot (webtty);
- migrarea cap-coadă a unui workspace vechi cu date reale (acoperită doar de testele unitare);
- seatbelt pe macOS.

---

## Pasul 2: `.data/robots` și eliminarea `.private`

**Schimbări în ploinky**
- Se elimină complet mecanismul `.private`:
  - garda `private` și `ensurePrivateDataRoot` (`controllerStateGuards.js`, `cli/sandbox/hostLaunchExclusion.js`);
  - ramura `.private` din `agentDataPathPolicy.assertManifestVolumeStoragePolicy`;
  - `seatbeltPrivateDataGrants`;
  - rădăcina `root:'private'` din `homeProfileProvider.mjs`.
- `homeProfileProvider.mjs`: o rădăcină nouă `root:'robots'` rezolvă `.data/robots/<cale>`. Se acceptă doar pentru un agent care declară volumul `.data/robots`. Se păstrează verificările de cale canonică și fără symlink-uri.
- `cli/utils/git/gitCredentials.js`:
  - `DEFAULT_RELATIVE_DIR` devine `.data/dpu-data/git-credentials`;
  - verificările `.private` se înlocuiesc cu: override-ul `PLOINKY_GIT_CREDENTIALS_DIR` nu poate arăta în `.data/agents/*` și nici în `.data/robots`.
- Montarea `gitCredentials` folosește grantul explicit deja recunoscut de garda `workspace-data`; nu a fost necesar un mecanism `dataGrant` suplimentar.

**Schimbări în roboWorkAgent**
- `manifest.json`: se scoate `".data/.private/roboWorkAgent": "/data"` și se adaugă `".data/robots": "/robots"`.
- `server/constants.mjs`, `scripts/prepare-data.mjs`, `scripts/robot-shell.mjs`: `DATA_DIR` devine `/root`. Se adaugă `ROBOTS_DIR=/robots`.
- `server/robot-paths.mjs`:
  - `robot(id)` = `/robots/<id>`;
  - `run(robotId, runId)` = `/robots/<robotId>/runs/<runId>`;
  - `privateRoot` se elimină;
  - zonele protegate devin `/root` și `/robots`.
- `server/run-manager.mjs`: căutarea unei rulări după `runId` folosește un index `runId → robotId`, refăcut la pornire din `meta.json`.
- `server/git-credentials.mjs`: credențialele sunt în `/robots/.credentials/<id>.json`.
- `server/terminal-profiles.mjs`:
  - profilul live întoarce `{root:'robots', path:'<id>/home'}`;
  - stub-ul trece din `<ws>/.data/roboWorkAgent/terminal/<id>` în `/robots/<id>/terminal`, iar ploinky îl rezolvă ca `.data/robots/<id>/terminal`.
- `server/launch.mjs`, `server/gui-manager.mjs`: tmpfs peste `/root` și `/robots`, apoi re-bind doar pentru robotul curent.
- `server/environment.mjs`: regex-ul `.data/.private` devine refuz pentru orice sursă de volum din `.data`.
- `server/workspace-view.mjs` ascunde deja `.data` și rămâne neschimbat.
- Specificații: AGENTS.md, DS002, DS003, plus roboTeamAgent DS004 și DS006.
- Teste: `tests/mcp-schema`, `workspace-view`, `gui-manager`, `git-credentials`.

**roboTeamAgent** nu are nevoie de `/robots`, pentru că vorbește cu roboWork prin HTTP.

**Migrare (versiunea 2 → 3)**

| Sursă | Destinație |
| --- | --- |
| `.data/.private/roboWorkAgent/robots/<id>/*` | `.data/robots/<id>/` |
| `.data/.private/roboWorkAgent/runs/<runId>` | `.data/robots/<robotId>/runs/<runId>` (robotId citit din `meta.json`; rulările fără robot valid rămân în `.data/agents/roboWorkAgent/orphan-runs/`) |
| `.data/.private/roboWorkAgent/credentials/<id>.json` | `.data/robots/.credentials/<id>.json` |
| `.data/.private/roboWorkAgent/{tool-cache,server-state,proxy-pool,...}` | `.data/agents/roboWorkAgent/` (merge permis explicit, numele nu se suprapun) |
| `.data/agents/roboWorkAgent/terminal/<id>` | `.data/robots/<id>/terminal` |
| `.data/.private/.git-credentials` | `.data/dpu-data/git-credentials` |

La final se șterge `.data/.private` dacă e gol. Altfel migrarea se oprește și raportează ce a rămas.

Descriptorii `server-state/terminal/*.json` conțin căi absolute și sunt invalidați. Artefactele temporare ale terminalelor întrerupte de destroy sunt păstrate în `server-state/terminal-layout-v2`, în afara directorului activ.

**Gata când:** roboții pornesc cu home, terminal, GUI și git funcțional, `ploinky update` folosește credențialele din locul nou, iar în cod și în workspace nu mai există nimic legat de `.private`.

---

### Detalii suplimentare implementate în pasul 2

- Profilurile WebTTY live și stub folosesc ambele `{root:'robots', path:'<id>/home|terminal'}`. Routerul verifică declarația volumului și montarea writable din generația exactă a agentului. Profilurile string ale altor agenți rămân compatibile.
- `robot-manager`, descoperirea modelelor, selecția mediilor și scripturile shell folosesc noile rădăcini. Indexul existent după `runId` se reconstruiește din directoarele roboților și refuză identificatori duplicați.
- Cache-ul Podman se păstrează la `/root/podman/images`. Configurația derivată din imagine este `/root/server-state/podman-storage.conf`; graphroot și runroot rămân în tmpfs. Imaginea existentă nu necesită rebuild.
- Ștergerea robotului păstrează istoricul rulărilor, inclusiv după restart. Directoarele care conțin doar istoric nu apar în catalogul roboților sau al terminalelor. Decizia unei eventuale ștergeri în cascadă rămâne amânată și trebuie reamintită utilizatorului după implementare.
- Migrarea reală în `/home/mircea/Desktop/ploinky-test`, după `ploinky destroy`, a păstrat hash-urile și inode-urile celor 8 fișiere verificate. Toți cei 10 agenți au pornit. Probele locale au verificat montările, izolarea shell-ului robotului, scrierea în home, credențiale criptate și helper-ul Git, Browser și Desktop; roboții temporari au fost eliminați.
- Teste finale: Ploinky 233 trecute, 0 eșecuri, 8 teste seatbelt omise pe Linux; roboWork și RoboTeam 200/200; unitarele probelor roboWork 29/29; helper-ele smoke selectate 679 trecute, 3 probe privilegiate omise. Cele 9 eșecuri suplimentare din fixture-urile vechi de politici se reproduc pe HEAD. Validatorul manifestului: 0 erori. Documentația agenților trece verificarea linkurilor; verificarea rădăcinii semnalează doar importul Mermaid lipsă deja existent.
- Validarea locală nu reprezintă suita completă de browser Explorer și nu verifică seatbelt pe macOS. Master key-ul și manifestul dpuAgent rămân pentru pasul 3.

---

## Pasul 3: dpuAgent primește `.data` și master key se mută în `.data/dpu-data`

**Schimbări în ploinky**
- Un volum declarat cu destinația `/root` înlocuiește montarea implicită a home-ului, în docker, bwrap și seatbelt. Garda `data` acceptă volumele declarate `.data/dpu-data` → `/root` și `.data` → `/workspace-data` ca excepții pentru acest agent.
- Excepția temporară `dpu-data` din `runtimeResourcePlanner.js` se elimină: `persistentStorage` rezolvă mereu în `.data/agents/<cheie>`.
- Master key:
  - `ploinky-box/entrypoint/initialize-workspace.mjs` (`workspaceMasterKeyPath`) și `cli/utils/security/masterKey.js` (liniile 115 și 256) folosesc `.data/dpu-data/master-key`, cu aceleași verificări: fișier obișnuit, mod `0600`, proprietar corect, fără symlink-uri;
  - `PLOINKY_MASTER_KEY` din mediu sau din `.env` rămâne prioritar, ca acum;
  - se actualizează mesajele și comentariile din `cli/utils/security/secretsFileCodec.js`, `subjectIdentityKey.js` și `cli/commands/noWaitWorker.js`.
- Testele de siguranță din Box (`tests/unit/ploinkyBoxSafetyMatrix.test.mjs`, `tests/e2e/ploinkyBox/publicCli.test.mjs`, `ploinkyBoxSmokeGraph`, `masterKeySubkeyCache`, `lifecycleHostHookEnv`, `workspaceFileProtection*`): master key-ul este vizibil doar pentru dpuAgent și pentru ploinky. Niciun alt agent nu îl vede, nici prin variabile de mediu, nici prin mount-uri.
- Documentație: specificațiile DS din ploinky nu se modifică (regula din `AGENTS.md`); se actualizează doar comentariile și mesajele din cod.

**Schimbări în dpuAgent**
- `manifest.json`: `"volumes": { ".data/dpu-data": "/root", ".data": "/workspace-data" }`. Se scoate `persistentStorage`, iar `DPU_DATA_ROOT` devine `/root`. O variabilă nouă (de exemplu `DPU_WORKSPACE_DATA_ROOT=/workspace-data`) îi spune unde e tot `.data`.
- `docs/specs/DS002-storage-architecture.md` și README.
- Codul nu se schimbă: `getDpuDataRoot()` citește deja `DPU_DATA_ROOT`.

**Migrare (versiunea 3 → 4)**
- Se copiază `.ploinky/data/master-key` în `.data/dpu-data/master-key` (fsync, verificare byte cu byte, mod `0600`), apoi se șterge originalul.
- La vechea locație rămâne un fișier gol, mod `0600`, ca marcaj. Un marcaj textual nu este sigur: fallback-ul host vechi l-ar accepta drept seed. Fișierul gol face cititoarele vechi să refuze pornirea.
- Rulează pe host după `ploinky destroy`, înainte de crearea Box-ului și de citirea cheii.

**Gata când:** dpuAgent își găsește datele în `/root`, secretele (`.secrets`, sesiunile SSO, credențialele git) se decriptează după migrare, iar testele de siguranță din Box trec.

---

## Pasul 4: agenții trec pe `/root`, explorer vede `.data` prin dpuAgent

**Agenții își iau datele din `/root`**

Datele sunt deja în `.data/agents/<x>`, cu o excepție: starea veche `.data/agents/workspace-monitor` se mută în `.data/agents/workspaceMonitorAgent` la migrarea 3 → 4. Mutarea păstrează inode-urile și refuză conflictele. Pentru ceilalți agenți se schimbă doar codul și manifestul:
- roboTeamAgent: `DATA_DIR`, `server/workspace-paths.mjs` (proiecția `/data` ↔ `<ws>/.data/roboTeamAgent` devine `/root` ↔ `.data/agents/roboTeamAgent`) și `copilot/src/lib/execution/alaRemote.mjs`. Se scoate volumul `/data`.
- userPersistoAgent, soul-gateway, emailAgent: `/data` devine `/root`, iar volumul se scoate.
- explorer: `private-data-boundary.mjs` (`.data/explorer` devine `/root`), `tool-handlers.mjs` (`plugin-settings.json`), `avatar-settings-store.mjs`, `markdown-crdt-store.mjs`, `webmeet-media-store.mjs`.
- gitAgent: `lib/github-auth.mjs` (`.data/gitAgent/github-auth` devine `/root/github-auth`).
- workspaceMonitorAgent: `persistentStorage` se înlocuiește cu home-ul `/root`.
- Volumele care țin de imagini terțe rămân, traduse automat: onlyOffice, liveKit redis/recordings, local-llm.
- Specificațiile și testele smoke din AssistOSExplorer (`tests/smoke/lib/*`, `qa-teardown`) trec pe căile noi.

**Ploinky:** proiecția home-ului la `<ws>/.data/agents/<nume>` rămâne pentru verificările de cale RoboTeam și compatibilitatea agenților externi. Explorer static primește acum home-ul privat la `/root`, iar workspace-ul rămâne montat la calea reală.

**Ce vede fiecare user în explorer**
- dpuAgent oferă `dpu_data_list`, `dpu_data_stat`, `dpu_data_read`, `dpu_data_download` peste `/workspace-data`, adică peste tot `.data`. Arborele permite doar citirea.
- Fișierul `dpu-data/master-key` este refuzat de aceste unelte pentru toată lumea, inclusiv pentru admini. Restul fișierelor cu credențiale sunt criptate și rămân vizibile adminilor.
- Regulile de acces folosesc rolurile deja existente în dpu (`isAdmin`): adminii văd tot, ceilalți doar `agents/explorer`. Toate operațiile se notează în auditul dpu.
- explorer adaugă un arbore virtual `.data`, după modelul `/Confidential` (`file-exp-dpu-provider.js`, `services/dpu/dpuPaths.js`).
- Blocarea `.data` în accesul direct la fișiere (`protected-workspace-paths.mjs` și routerul ploinky, care trebuie să rămână identice) nu se schimbă. Accesul trece doar prin dpu.

**Gata când:** agenții își citesc datele din `/root`, adminii văd tot `.data` în explorer, iar un user normal vede doar `agents/explorer`.

### Implementare și verificare pentru pașii 3 și 4

- Override-ul `/root` funcționează prin declarațiile de volume, inclusiv profile, fără nume de agenți codificate în runtime. Docker și bwrap montează home-ul o singură dată; seatbelt rezolvă căile fizice și variabilele de mediu corespunzătoare.
- DPU verifică identitatea autentificată și rolurile. Refuză symlink-uri, hardlink-uri la fișiere, traversarea directoarelor și cheia master, inclusiv artefactele temporare `master-key.*`. Auditul înregistrează operațiile acceptate și refuzate. Citirile sunt limitate la 1 MiB per cerere.
- Explorer afișează `/.data` prin providerul DPU. Preview-ul citește cel mult 256 KiB; download-ul folosește bucăți și admite cel mult 64 MiB. Crearea, editarea și ștergerea nu sunt disponibile în acest arbore.
- În `ploinky-test`, migrarea după destroy a păstrat hash-ul cheii master. Structura este versiunea 4, vechiul fișier este gol, iar cei 10 agenți au pornit. Probele au verificat home-urile, volumul DPU și inaccesibilitatea cheii din ceilalți agenți.
- Apelul real `ploinky client tool dpu_data_list --agent dpuAgent` trece prin router și returnează noul arbore. `dpu_data_read` refuză cheia master prin același router, inclusiv pentru operatorul admin. Probele DPU din container și testele providerului verifică separat adminul și userul obișnuit.
- Ploinky: suita selectată a trecut 249 teste, cu 8 teste macOS omise. Testul suplimentar de migrare verifică decriptarea `.secrets` și a sesiunilor SSO după mutarea aceleiași chei; fișierul de migrare are 25 teste trecute. Workspace-ul real nu conținea `.secrets` sau sesiuni SSO persistate pentru această verificare.
- După verificarea atașării interactive și a profilelor fără configurare, reluarea testelor bwrap, migrare și rezolvare home seatbelt a trecut 59/59. Revalidarea providerului Explorer și a căilor private a trecut 2/2.
- DPU, Git și Explorer: 151 teste trecute. Helper-ele smoke: 225 trecute, 3 probe privilegiate omise. Validarea opririi QA: 109 trecute. Suita mai largă a agenților: 856 trecute; cele 12 eșecuri UI userPersisto se reproduc identic pe HEAD.
- Validatorul DPU nu raportează erori. Documentația agenților și helper-ele QA au fost actualizate. Nu s-a rulat suita completă de browser sau runtime-ul seatbelt pe macOS.

---

## Puncte deschise

Actualizare ulterioară pașilor 1–4: suportul `persistentStorage` a fost eliminat din planificator, registru și runtime-urile Docker, bwrap și seatbelt. Descrierile lui din etapele de mai sus reprezintă starea intermediară. Ultimul manifest local identificat, `proxies/opencode-free`, folosește acum home-ul automat `/root` pentru `service-state.json`. Pentru instanța fără alias, fișierul rămâne în același director pe host; nu necesită mutare. Testele selectate Ploinky: 146 trecute, 21 omise; opencode-free: 245 trecute, 15 omise; fără eșecuri. Nu s-au repornit agenții activi.

0. **Cum vede dpuAgent tot `.data` fără `/data`.** Rezolvat: varianta (b), `/root` = `.data/dpu-data` și `.data` întreg la `/workspace-data` (vezi regula 2).
1. **Numele `shared`** este rezervat ca nume de instanță și alias, inclusiv variantele cu majuscule. Admiterea și calculul home-ului îl refuză; `.data/agents/shared` rămâne folderul comun. Rezervarea este separată de cheile de metadate ale registrului, astfel încât înregistrările vechi rămân adresabile pentru curățare.
2. **Containere pornite la migrare.** Decizia din pasul 1 este înlocuită pentru pasul 2: `ploinky destroy` este obligatoriu înaintea migrației.
3. **Agenții din alte repo-uri.** Extinderea de mai jos trece promotionScout, proxyAgent, local-llm și bizanso pe `/root`. WebMeet este amânat. webSearchAgent, browserUseAgent și openInterpreterAgent nu mai sunt folosiți și sunt excluși din migrare.
4. **Istoricul robotului șters.** Decizie confirmată: ștergerea robotului păstrează istoricul execuțiilor și logurile.
5. **Referințele OAuth Soul Gateway.** Corectate prin migrare la pornirea serviciului, înainte de încărcarea conturilor: prefixul `/data/credentials/` este înlocuit cu `CREDENTIALS_DIR` numai după verificarea și decriptarea fișierului relocat. Tranzacția nu schimbă fișierele criptate. Validat pe o copie izolată a bazei și credențialelor instanței active, plus citire și refresh în teste. Suita Soul Gateway: 1350 trecute, 0 eșecuri, 2 omise. Instanța activă nu a fost repornită; migrarea ei se aplică la următoarea pornire cu codul nou.


### Extinderea migrării la agenții folosiți din alte repo-uri

promotionScout, proxyAgent, local-llm și bizanso nu mai declară volume de date în manifest. Ploinky le oferă automat `/root`, din `.data/agents/<numele instanței sau alias>`. WebMeet rămâne amânat; webSearchAgent, browserUseAgent și openInterpreterAgent sunt excluși. Varianta intermediară cu volume explicite la `/root` a fost înlocuită.

Pentru numele canonice, Scout, proxyAgent și local-llm au deja datele în home-ul corect. Bizanso necesită mutarea din `.data/agents/bizansoAgent` în `.data/agents/bizanso`, păstrând metadatele existente în home. Pentru alias-uri, migrarea citește registrul și mută vechiul director fix în home-ul alias-ului. Nu se șterg loguri, baze de date sau modele.

Migrarea generică este `scripts/migrate-agent-homes.mjs`. Numele agenților sunt în planul de operator `proposals/automatic-agent-homes.json`, nu în runtime sau în manifeste. Rulează sub lock-ul workspace-ului, cu verificarea că Box-ul a fost distrus și că nu rulează agenți pe host. Aplică întâi layout-ul curent dacă este necesar. Verifică toate mutările înainte să înceapă, refuză conflictele și symlink-urile, apoi folosește rename și fsync. O reluare continuă mutările rămase fără să suprascrie fișierele mutate anterior. Dacă mai multe instanțe foloseau același director vechi, refuză migrarea până când operatorul separă explicit datele; nu alege arbitrar un proprietar.

Pe fiecare server, cu versiunile noi publicate și disponibile:

1. Din workspace, rulează `ploinky destroy`, fără `--delete-data`. Nu folosi operația `destroy` a helper-ului Bizanso, care poate șterge datele.
2. Păstrează un backup al `.data` și `.ploinky`, apoi actualizează Ploinky și repo-urile agenților cu totul oprit.
3. Tot din workspace, rulează:

   ```sh
   node /cale/catre/ploinky/scripts/migrate-agent-homes.mjs --plan /cale/catre/ploinky/proposals/automatic-agent-homes.json
   ```

   Planul folosește numele repo-urilor înregistrate `PromotionScoutV2`, `PloinkyProxies`, `local-llms` și `bizanso`. Dacă un deployment le-a înregistrat sub alte nume, adaptează `repoName` în copia planului înainte de rulare. Alias-urile de instanță sunt citite automat.
4. Numai după succesul migrării, rulează `ploinky start`. Verifică fișierele existente prin `/root`, configurația serviciilor Scout și inventarul modelelor local-llm. Rutele HTTP Bizanso `/data/*` rămân neschimbate.

Scout migrează separat, la pornire, căile persistate ale serviciilor din `config.json`, sub lock-ul de lifecycle. Override-urile vechi cu prefix `/data` sunt traduse la `/root`; cele către alte directoare rămân păstrate. Helper-ele remote Bizanso verifică acum home-ul canonic `.data/agents/bizanso`.

Modificarea local-llm este în checkout-ul `.ploinky/repos/local-llms`; trebuie păstrată și publicată înaintea unui update care îl înlocuiește. Modificările nu au fost publicate sau aplicate pe servere remote.


Verificare: 120 teste Ploinky pentru layout, migrarea home-urilor și supervisor; 35 teste Bizanso; 5 teste de contract local-llm. Toate au trecut. Cele patru manifeste trec validatorul și nu au `volumes`. Proba pe workspace-ul activ a fost refuzată cu mesajul că este necesar `ploinky destroy`, fără mutarea datelor. Aplicarea efectivă pe instanța locală și pe remote necesită secvența offline de mai sus.


### SQLite references and launch admission

The offline plan's Bizanso entry includes a declarative SQLite rewrite for `jobs.result_json.files`. The same host command that moves the home rebases `/data/`, the old flat host source, and the old `.data/agents/<sourceKey>/` host source to `/root/`. It changes only the declared array's matching paths, preserves other JSON fields and log contents, and does not delete or merge databases. The SQLite primary key and JSON column must exist; invalid JSON, unsafe paths, links, and competing database files are refused. No database is created when no source or destination database exists.

The complete filesystem and database preflight happens before moves. A durable `.ploinky/agent-home-migration-pending.json` marker precedes mutations. SQLite updates use a transaction; the marker is removed only after all moves and rewrites succeed. An interrupted operation must be resumed with the same plan. The marker blocks launches even if the source directory has already disappeared.

Bizanso ships `home-migration.json` with historical home keys, separately from `manifest.json`. This file defines no volumes. Shared runtime admission checks it before container, bwrap, and seatbelt launches, including monitor-driven recovery. If the legacy home contains data, launch is refused even when a new database already exists at the destination. A genuinely fresh installation remains allowed. Ploinky and the agent repository must both be upgraded for this guard to apply.

This is an explicit offline operation, not an agent install hook: `ploinky destroy`, update Ploinky and agents, run `scripts/migrate-agent-homes.mjs --plan proposals/automatic-agent-homes.json` from the workspace using absolute checkout paths, then `ploinky start`. Install is not allowed to resolve conflicts or discard a destination database. Two databases require a separate operator decision; the migration preserves both and refuses the conflict.
