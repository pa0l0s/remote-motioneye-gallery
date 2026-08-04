# Etykietowanie klatek modelem wizyjnym — projekt integracji

Data: 2026-08-04
Status: do zatwierdzenia

## 1. Cel

Galeria ma **dwa niezależne przebiegi detekcji**, działające równolegle i nigdy nie
blokujące się nawzajem:

**Przebieg podstawowy — różnicowanie klatek, bez żadnych zależności zewnętrznych.**
Działa automatycznie, dokładnie jak dotąd. Jest zawsze dostępny, kosztuje milisekundy
i nie wymaga niczego poza NAS-em. Odpowiada na pytanie „czy coś się w kadrze zmieniło".

**Przebieg rozszerzony — model wizyjny w LM Studio, opcjonalny.** Co ~5 minut sprawdza,
czy model jest załadowany na stacji roboczej. Jeśli tak — skanuje; jeśli nie — śpi
i nic się nie dzieje. Odpowiada na pytania semantyczne: **czy jest człowiek, czy jest
zwierzę, jaka jest pogoda i widoczność**.

Wyniki obu przebiegów są przechowywane osobno, prezentowane osobno i filtrowane osobno.
Żaden nie nadpisuje ani nie unieważnia drugiego.

To rozdzielenie jest wymaganiem wprost, nie decyzją techniczną: galeria musi być
użyteczna także wtedy, gdy stacja robocza jest wyłączona — a wtedy jedyną dostępną
informacją jest przebieg podstawowy.

### Dlaczego oba są potrzebne

Przebieg podstawowy nie jest wadliwy — jest niewłaściwie postawiony jako *jedyne*
źródło prawdy. Mierzy, ile pikseli się zmieniło: na zajętym obozie w lipcu przekracza
próg w 57,5 % klatek doby, w pustym marcu w 0,2 %. Obie liczby są poprawne i obie
bezużyteczne jako odpowiedź na pytanie „pokaż mi, co ważnego się działo".

Ale ma dwie zalety, których przebieg rozszerzony nie ma i mieć nie będzie: **działa
zawsze** i **kosztuje tyle, co nic**. Dlatego zostaje jako pełnoprawny, samodzielny
tryb, a nie jako zapasowy.

## 2. Fakty pomiarowe, na których stoi ten projekt

Wszystkie liczby pochodzą z uruchomień na docelowym sprzęcie i na klatkach z archiwum.
Pełny raport: artefakt „Detekcja aktywności — raport pomiarowy".

**Model i parametry.** `qwen/qwen3-vl-8b` (GGUF Q4_K_M, ~6,2 GB), obraz skalowany do
szerokości **1024 px**, `temperature: 0`, odpowiedź wymuszona `response_format:
json_schema` ze `strict`.

**Wydajność** (RTX 2070 8 GB, model sam w VRAM, rozgrzewka odrzucona):

| wywołanie | mediana |
|---|---|
| semantyka (osoby, zwierzęta) — schemat wąski | **1 336 ms** |
| pogoda (widoczność, opad) — schemat wąski | **~3 300 ms** |
| ten sam model, schemat szeroki (7 pól + tekst) | 7 110 ms |

**Jakość na zbiorze referencyjnym** (67 klatek z ręcznymi etykietami):

- osoba: **6/6** wykrytych, **0/31** fałszywych alarmów na pustych klatkach
- zwierzęta: **6/6** na klatkach wskazanych przez właściciela (ptak 16×18 px, pies,
  dwa konie), **0** zmyślonych
- śnieg padający: **2/2**, w tym nocny w podczerwieni; nocna kontrola bez opadu → `none`
- gęsta mgła: **2/2**, w tym klatka, której **żadna klasyczna statystyka nie zauważyła**
  (siedzi w p37–p49 rozkładu doby)

**Rzeczy, które zmierzono jako niedziałające** — sterują tym, czego ten projekt NIE robi:

- `vehicles_count` zwraca **zawsze dokładnie 1**, niezależnie od obecności auta
  (14 klatek z autem i 25 bez — identyczny wynik). Zero informacji.
- `lens_obstruction` jest prawdziwe niemal zawsze (29 fałszywych na 41 klatek). Zero informacji.
- Granica mgła / zwykłe zachmurzenie: niestabilna, w obu wersjach polecenia.
- `rain` bywa orzekany bez czegokolwiek widocznego w kadrze i **jest wtedy stabilny
  przez 6 kolejnych klatek** — potwierdzanie w sąsiednich klatkach nie pomaga.

**Zależności metodyczne, które muszą trafić do kodu:**

- Sformułowanie polecenia waży tyle, co wybór modelu: dopracowanie samego opisu sceny
  podniosło wykrywalność zwierząt z **2/6 na 6/6**, bez zmiany modelu i czasu.
- Swobodne pole tekstowe w schemacie psuje powtarzalność. Po jego usunięciu pięć powtórzeń
  daje identyczny wynik.
- Model rozumujący (Qwen3.5) wymaga `reasoning_effort: "none"`, inaczej zużywa cały budżet
  tokenów na myślenie i zwraca puste `content`.
- Noc w podczerwieni wykrywa się klasycznie i bezbłędnie przez nasycenie barw
  (`loadFrame().colorfulness` w `src/activity/diff.ts`) — nie ma powodu pytać o to modelu.

**Archiwum.** 209 029 klatek, 74 GB, doby 2024-07-04 … 2026-07-09, wszystko lokalnie na
NAS-ie. **Niejednorodne**: 800×480 wyzwalane ruchem (2024), 1280×720 co 300 s (2025),
1920×1080 co 150 s (2026). Zegar kamery w 2024 pokazuje rok 1970. Scena zmienia się
między latami (namiot → przyczepa z łódką → wiata).

## 3. Architektura

```
NAS 192.168.0.24  (Celeron G540, 2 rdzenie, bez AVX)
└── kontener motioneye-proxy-gallery
    │
    ├── PĘTLA A — przebieg podstawowy (istnieje dziś, bez zmian w logice)
    │   odczyt JPEG → skala 64×64 → różnicowanie → activityScore, hasActivity
    │   zależności: żadne.  interwał: 120 s.  zawsze aktywna.
    │
    └── PĘTLA B — przebieg rozszerzony (nowa, opcjonalna)
        sonda co 300 s: czy model jest załadowany?
          ├─ nie  → śpij, nie rób nic
          └─ tak  → odczyt JPEG → skala 1024 px → HTTP ──► Stacja 192.168.0.11:1234
                                                            LM Studio, RTX 2070
                                                            qwen/qwen3-vl-8b
                    ← zapis do kolumn ai* / weather*
```

Pętle są **całkowicie niezależne**: osobne funkcje, osobne kursory, osobne przełączniki
pauzy, osobne liczniki postępu, osobne kolumny w bazie. Jedyne, co dzielą, to te same
wiersze tabeli `MediaFile` — a że każda zapisuje wyłącznie własne kolumny przez
`UPDATE ... SET`, jedna nie może nadpisać wyniku drugiej.

Awaria, pauza albo niedostępność pętli B nie ma **żadnego** wpływu na pętlę A. Odwrotnie
także: pętla B nie czeka na pętlę A i nie wymaga, żeby klatka była wcześniej
zeskanowana różnicowo.

**Cała inferencja jest zdalna, cała reszta zostaje w istniejącym kontenerze.** NAS robi
tylko wejście/wyjście i skalowanie — czyli to, co i tak już robi przy miniaturach. Nie
powstaje żaden nowy serwis, nowy proces ani nowe API do zapisu wyników; nie trzeba
niczego uruchamiać na stacji roboczej poza samym LM Studio.

**Współbieżność.** Obie pętle działają w tym samym procesie Node. Pętla A jest ograniczona
procesorem (dekodowanie JPEG na dwurdzeniowym Celeronie), pętla B czeka głównie na sieć.
Żeby A nie głodziła B ani odwrotnie, każda pracuje z równoległością 1 i oddaje sterowanie
między klatkami. SQLite ma już włączony WAL i `busy_timeout` (commit 6d53efa), co pokrywa
równoczesne zapisy.

Odrzucone warianty i powód:

- **detektor ONNX na NAS-ie** — Celeron bez AVX, ~12 dni na jedno przejście archiwum,
  a klasy COCO i tak nie obejmują pogody;
- **osobny worker na stacji roboczej z własnym API zapisu** — wymaga drugiego serwisu,
  uwierzytelnienia i synchronizacji stanu; skalowanie obrazu na Celeronie okazało się
  wystarczająco tanie, żeby to było niepotrzebne;
- **przebieg kafelkowy dla małych obiektów** — wydawał się konieczny, dopóki nie okazało
  się, że problemem było polecenie, a nie rozdzielczość.

**Zero transferu GSM.** Klatki są już zsynchronizowane lokalnie; łącze do zdalnego
motionEye nie jest w ogóle używane.

## 4. Kontrakt z LM Studio

### 4.1 Bramka dostępności

`GET {AI_LMSTUDIO_URL}/api/v0/models` → w odpowiedzi szukamy pozycji o `id` równym
`AI_MODEL` i `state === "loaded"`.

Skanowanie rusza **wyłącznie** gdy ten warunek jest spełniony. To jest wyłącznik po
stronie właściciela: ładuje model w LM Studio, gdy chce oddać kartę na skanowanie,
i wyładowuje, gdy potrzebuje jej do czegoś innego. Sprawdzanie samego faktu, że LM Studio
działa, jest niewystarczające — przy włączonym JIT `/v1/models` listuje modele *pobrane*,
nie *załadowane*.

### 4.2 Wywołanie semantyczne

`POST {AI_LMSTUDIO_URL}/v1/chat/completions`

```jsonc
{
  "model": "<AI_MODEL>",
  "messages": [
    { "role": "system", "content": "<SYSTEM_SEMANTICS>" },
    { "role": "user", "content": [
      { "type": "text", "text": "How many people and how many animals can you see in this frame?" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]}
  ],
  "response_format": { "type": "json_schema", "json_schema": {
    "name": "frame_report", "strict": true,
    "schema": {
      "type": "object",
      "properties": {
        "people_count": { "type": "integer", "description": "How many humans are visible. A jacket or bag on a chair is not a human." },
        "animals": { "type": "array", "items": { "type": "string" },
          "description": "One entry per animal visible IN THE SCENE: bird, horse, deer, dog, cat, boar, fox, hare. Animals here are often small and far away - on the ground, in the field, or perched on objects. Do NOT list an insect or spider crawling on the camera lens." }
      },
      "required": ["people_count", "animals"]
    }
  }},
  "temperature": 0,
  "max_tokens": 250,
  "reasoning_effort": "none"
}
```

`SYSTEM_SEMANTICS` to zweryfikowany wariant „dopracowany" — wymienia **konkretne obiekty
sceny** (opona, łódka, ogrodzenie, linia lasu) i zawiera jawne polecenie *policz każde
zwierzę*. To nie jest kosmetyka: wariant ogólny daje 2/6 zamiast 6/6.

`reasoning_effort` wysyłamy zawsze — modele bez rozumowania go ignorują, a modele
rozumujące bez niego zwracają puste `content`.

**Pole `vehicles_count` i `lens_obstruction` nie są odpytywane.** Zmierzono, że nie niosą
informacji, a każde dodatkowe pole kosztuje realny czas (schemat szeroki: 7 110 ms vs 1 336 ms).

### 4.3 Wywołanie pogodowe

Osobne żądanie, osobne polecenie systemowe nastawione na widoczność w dali, schemat:

```jsonc
{
  "visibility": { "type": "string", "enum": ["clear", "slight_haze", "fog", "dense_fog"] },
  "precipitation": { "type": "string", "enum": ["none", "rain", "heavy_rain", "snow"] },
  "snow_on_ground": { "type": "boolean" }
}
```

Uruchamiane **tylko dla klatek dziennych** (bramka klasyczna, patrz 6.4) i **nie częściej
niż co `AI_WEATHER_MIN_GAP_SECONDS`** (domyślnie 600 s) licząc od poprzedniej klatki
z wypełnioną pogodą tej samej kamery. Pogoda zmienia się wolno; skanowanie każdej klatki
byłoby marnotrawstwem 3,3 s.

Próbkowanie jest **oparte na czasie, nie na numerze klatki**. Interwał zapisu zmieniał się
przez lata (300 s w 2025, 150 s w 2026), a w 2024 kamera pracowała w trybie wyzwalanym
ruchem z odstępami 1–3 s — reguła „co czwarta klatka” dałaby tam wywołanie pogodowe co
kilka sekund.

### 4.4 Normalizacja odpowiedzi

Model zwraca `animals` jako swobodne napisy: `"horse"`, `"1 dog"`, `"1 bird on a tire"`.
Zapisujemy **oba**: surową tablicę (`aiAnimals`, JSON) oraz znormalizowany zbiór gatunków
(`aiAnimalKinds`, lista rozdzielona przecinkami) uzyskany przez dopasowanie słów
kluczowych do słownika: `bird, dog, cat, horse, deer, boar, fox, hare, other`. Liczba
zwierząt = długość surowej tablicy.

Wariant alternatywny — wymuszenie `enum` na elementach tablicy — jest kandydatem na
pierwszy eksperyment strojący (patrz 11), ale **nie wchodzi do wersji podstawowej, bo nie
został zmierzony**.

## 5. Model danych

Rozszerzenie `MediaFile` (migracja Prisma, wyłącznie nowe kolumny nullowalne):

```prisma
// Etykiety semantyczne z lokalnego modelu wizyjnego.
aiScannedAt     DateTime?
aiModel         String?   // np. "qwen/qwen3-vl-8b" — po czym poznamy, czym to liczono
aiPromptVersion String?   // np. "semantics-v1" — pozwala przeliczyć tylko to, co trzeba
aiPeopleCount   Int?
aiAnimals       String?   // surowa tablica JSON z modelu
aiAnimalKinds   String?   // znormalizowane gatunki, np. "bird,dog"
aiLatencyMs     Int?
aiFailures      Int       @default(0) // kolejne nieudane próby; po AI_MAX_FAILURES odpuszczamy

// Pogoda — osobne wywołanie, rzadsza próbkowanie, tylko klatki dzienne.
weatherScannedAt     DateTime?
weatherPromptVersion String?
weatherVisibility    String?  // clear | slight_haze | fog | dense_fog
weatherPrecipitation String?  // none | rain | heavy_rain | snow
weatherSnowOnGround  Boolean?

// Klasyczne, deterministyczne — liczone lokalnie, nie przez model.
isNightIr Boolean?
```

Indeksy: `[cameraId, aiScannedAt]`, `[cameraId, aiPeopleCount, timestamp]`,
`[cameraId, weatherVisibility, timestamp]`.

**Istniejące pola `activityScore` / `hasActivity` / `activityScannedAt` zostają
nietknięte i pozostają pełnoprawnym, samodzielnym wynikiem.** Nie są zapasem ani
półproduktem: to rezultat przebiegu podstawowego, który ma własny filtr w interfejsie
i własny licznik postępu. Pętla B nigdy ich nie czyta ani nie zapisuje.

Rozdział kolumn jest ścisły:

| przebieg | zapisuje wyłącznie |
|---|---|
| A — podstawowy | `activityScore`, `hasActivity`, `activityScannedAt` |
| B — rozszerzony | `ai*`, `weather*`, `isNightIr` |

Klatka może być oznaczona przez jeden przebieg, przez oba albo przez żaden — i każdy
z tych czterech stanów jest poprawny oraz rozróżnialny w interfejsie.

## 6. Pętle skanujące

### 6.0 Pętla A — przebieg podstawowy

**Bez zmian w logice.** `src/activity/` zostaje jak jest: `runActivityScanOnce`, własny
`ScanControl`, własny interwał, własne trasy pauzy i wznowienia. Jedyne zmiany to
naprawa `POST /api/activity/rescan` (patrz 6.6) i rozdzielenie stanu w interfejsie,
żeby postęp przebiegu podstawowego był widoczny osobno od rozszerzonego.

Pętla A nie wie o istnieniu pętli B i nigdy nie sprawdza jej stanu.

### 6.1 Pętla B — przebieg rozszerzony

Nowy moduł `src/ai/` obok istniejącego `src/activity/`, o analogicznej budowie, ale
z **osobnym** `ScanControl` — nie współdzielonym z pętlą A, bo pauza jednego przebiegu
nie może zatrzymywać drugiego.

Sterowanie jest oparte na sondzie dostępności, nie na stałym interwale skanowania:

```
co AI_PROBE_INTERVAL_SECONDS (300 s):
    czy AI_MODEL ma state == "loaded"?
        nie  → nic nie rób, śpij do następnej sondy
        tak  → skanuj partiami po AI_BATCH klatek, tak długo jak:
                 - model pozostaje załadowany, oraz
                 - są klatki do zeskanowania, oraz
                 - nie ustawiono pauzy
               po wyczerpaniu zaległości → wróć do sondowania
```

Dopóki model jest załadowany, skanujemy **ciągle**, a nie co dwie minuty — właściciel
załadował go po to, żeby oddać kartę na tę robotę, więc nie ma powodu marnować
dostępności. Sonda co 5 minut dotyczy wyłącznie stanu „model niedostępny".

Zniknięcie modelu w trakcie partii jest wykrywane po pierwszym nieudanym żądaniu:
partia jest przerywana czysto, nic nie zostaje oznaczone, pętla wraca do sondowania.

### 6.2 Kolejność

**Od najnowszych do najstarszych.** Właściciel przegląda przede wszystkim świeży materiał,
a backfill i tak potrwa dni; sensowne jest, by najpierw stała się przeszukiwalna ostatnia
doba, potem tydzień, potem reszta. Kursor jest wyznaczany zapytaniem
`WHERE aiScannedAt IS NULL ORDER BY timestamp DESC`, więc nowe klatki naturalnie wskakują
przed zaległości.

### 6.3 Krok

Dla każdej klatki (obraz, `isDownloaded = true`):

1. policz `isNightIr` klasycznie (nasycenie barw < próg) — tanie, deterministyczne;
2. wykonaj wywołanie semantyczne; zapisz wynik, `aiModel`, `aiPromptVersion`, `aiLatencyMs`;
3. jeśli klatka jest dzienna i od ostatniej klatki z wypełnioną pogodą minęło co najmniej
   `AI_WEATHER_MIN_GAP_SECONDS` — wykonaj wywołanie pogodowe.

### 6.4 Bramka nocna

Pytanie o pogodę zadajemy **tylko klatkom dziennym**. Powód jest zmierzony: model orzeka
`dense_fog` na czarnych klatkach nocnych z gałęzią rozświetloną lampą IR. Klasyczny test
nasycenia odsiewa je bezbłędnie i za darmo. Nocne klatki mają `weatherScannedAt` ustawione,
a pola pogodowe `null` — żeby nie były w kółko próbowane.

### 6.5 Awarie

Rozróżniamy dwie sytuacje, inaczej niż w istniejącym skanerze różnicowym:

- **model niedostępny** (bramka 4.1 nie przechodzi, timeout, 5xx) — nie zapisujemy niczego,
  nie zwiększamy licznika, kończymy cykl i czekamy do następnego. To stan normalny:
  właściciel wyłączył model.
- **klatka nie do przetworzenia** (plik uszkodzony, 4xx, odpowiedź niezgodna ze schematem) —
  `aiFailures += 1`; po `AI_MAX_FAILURES` ustawiamy `aiScannedAt` z pustym wynikiem, żeby
  pętla szła naprzód.

Rozdzielenie jest istotne: potraktowanie niedostępności modelu jak błędu klatki
zaowocowałoby cichym oznaczeniem całego archiwum jako „przeskanowane, nic nie znaleziono".

### 6.6 Zmiana polecenia lub modelu

Nie kasujemy wyników. Przy zmianie `AI_PROMPT_VERSION` pętla traktuje jako niezeskanowane
te klatki, u których `aiPromptVersion` różni się od bieżącej — dzięki czemu przeliczenie
po zmianie polecenia jest zwykłym, wznawialnym backfillem, a stare etykiety pozostają
widoczne do czasu zastąpienia.

Przy okazji naprawiamy `POST /api/activity/rescan`, który dziś kasuje również
`activityScore` i wymusza ponowne dekodowanie 209 tysięcy plików, choć zmiana samego progu
tego nie wymaga.

## 7. API

### 7.1 Stan — osobno dla każdego przebiegu

`GET /api/activity/status` zostaje bez zmian i dotyczy **wyłącznie** przebiegu
podstawowego: `enabled`, `paused`, `scanning`, `totalLocalImages`, `scanned`, `pending`,
`withActivity`.

`GET /api/ai/status` — nowa trasa, analogiczna, dotyczy **wyłącznie** przebiegu
rozszerzonego:

```jsonc
{
  "enabled": true,          // AI_TAGGING_ENABLED
  "paused": false,
  "scanning": true,
  "modelLoaded": true,      // wynik ostatniej sondy
  "model": "qwen/qwen3-vl-8b",
  "lastProbeAt": "2026-08-04T08:15:00Z",
  "totalLocalImages": 209029,
  "scanned": 14320,
  "pending": 194709,
  "weatherScanned": 1180,
  "withPeople": 412,
  "withAnimals": 87,
  "withWeather": 233,       // mgła gęsta lub opad
  "medianLatencyMs": 1341,
  "lastError": null
}
```

Rozdzielenie tras jest celowe: interfejs musi umieć pokazać, że jeden przebieg pracuje,
a drugi śpi, i nie może brać jednego stanu za drugi.

`POST /api/ai/pause` i `/api/ai/resume` — niezależne od `POST /api/activity/pause`.

### 7.2 Filtrowanie

`GET /api/media` przyjmuje parametr `detections` — **lista rodzajów rozdzielona
przecinkami**, semantyka: pokaż klatkę, jeśli pasuje do **któregokolwiek** z zaznaczonych
rodzajów (suma logiczna). Brak parametru = bez filtrowania.

| wartość | przebieg | warunek |
|---|---|---|
| `motion` | A | `hasActivity = true` |
| `people` | B | `aiPeopleCount > 0` |
| `animal` | B | `aiAnimalKinds` niepuste |
| `animal:bird`, `animal:dog`, `animal:horse`, … | B | dany gatunek w `aiAnimalKinds` |
| `fog` | B | `weatherVisibility = 'dense_fog'` |
| `snow` | B | `weatherPrecipitation = 'snow'` |
| `snow_ground` | B | `weatherSnowOnGround = true` |
| `night` | B | `isNightIr = true` |

Przykład: `?detections=motion,people,animal:bird` → klatki z ruchem **albo** z osobą
**albo** z ptakiem.

Dodatkowo `scannedBy=basic|ai|both|none` pozwala pytać wprost o **pokrycie**, niezależnie
od tego, co znaleziono: które klatki widział przebieg podstawowy, które rozszerzony,
które oba, a których żaden. To jest potrzebne przy backfillu, żeby widzieć, dokąd
przebieg rozszerzony doszedł.

Wartości niedostępne w wersji podstawowej — `rain`, `haze`, `vehicle`, `lens` — **nie są
wystawiane jako filtry**, bo zmierzono, że nie niosą informacji (patrz 11). Dane są
zapisywane, więc filtr można włączyć później bez migracji.

### 7.3 Histogram

`GET /api/timeline/histogram` → obok istniejącego `activityCount` (przebieg A) dochodzą
`peopleCount`, `animalCount`, `weatherCount` (przebieg B), każde jako osobna dzienna suma.

## 8. Interfejs

Rozszerzenie istniejących elementów, bez nowych ekranów.

### 8.1 Panel filtrów

Obecny przełącznik „tylko aktywność" zastępuje panel z **przełącznikami dla każdego
rodzaju detekcji z osobna**, zgrupowanymi według przebiegu, który je wytworzył:

```
┌─ Przebieg podstawowy ─────────────┐   ┌─ Przebieg rozszerzony (model) ─────────┐
│ ☐ ruch w kadrze            1 284  │   │ ☐ osoba                          412   │
└───────────────────────────────────┘   │ ☐ zwierzę — dowolne                87  │
                                        │     ☐ ptak      54                     │
        [ wszystkie ]  [ wyczyść ]      │     ☐ pies      18                     │
                                        │     ☐ koń        9                     │
                                        │     ☐ sarna      4                     │
                                        │     ☐ inne       2                     │
                                        │ ☐ gęsta mgła                     198   │
                                        │ ☐ opad śniegu                     35   │
                                        │ ☐ śnieg na ziemi                 611   │
                                        │ ☐ noc (podczerwień)            9 044   │
                                        └────────────────────────────────────────┘
```

Zasady:

- **Każdy rodzaj włącza się i wyłącza osobno.** Zaznaczenie kilku daje sumę — klatka
  pasuje, jeśli spełnia którykolwiek zaznaczony warunek.
- **Nic nie zaznaczone = wszystkie klatki.**
- Liczniki przy każdym rodzaju pokazują, ile klatek go spełnia w bieżącym zakresie dat.
- Grupa gatunków zwierząt jest zwijana; „zwierzę — dowolne" jest nadrzędne wobec
  pojedynczych gatunków.
- Grupa „Przebieg rozszerzony" jest **wygaszona z notatką**, gdy model nigdy nic nie
  oznaczył — żeby nie sugerować, że filtry są zepsute, kiedy po prostu nie było skanowania.

Osobno, poza listą rodzajów, przełącznik **pokrycia**: *widziane przez przebieg
podstawowy / rozszerzony / oba / żaden*. Odpowiada na inne pytanie niż filtry powyżej —
nie „co znaleziono", tylko „co zostało obejrzane".

### 8.2 Kafelek

Odznaki są **wizualnie rozdzielone według przebiegu**, żeby jednym spojrzeniem było
widać, skąd pochodzi informacja:

- przebieg podstawowy — dotychczasowa bursztynowa obwódka i kropka „ruch";
- przebieg rozszerzony — ikony kategorii w rogu: sylwetka (osoba), gatunek zwierzęcia
  (z nazwą, jeśli znany), mgła, płatek śniegu.

Klatka oznaczona przez oba przebiegi pokazuje oba zestawy. Klatka, której model jeszcze
nie widział, nie pokazuje niczego z grupy rozszerzonej — i **nie jest w żaden sposób
odróżniana od klatki, na której model nic nie znalazł**, chyba że włączono przełącznik
pokrycia.

### 8.3 Oś czasu

Obecne bursztynowe wypełnienie dobowe zostaje jako przebieg podstawowy. Dochodzą dwa
niezależne pasma z przebiegu rozszerzonego: obecność ludzi i obecność zwierząt. Pasma
są rysowane niezależnie, bo dotyczą różnych pytań i mogą się nie pokrywać.

### 8.4 ScanStatusTray

Dwa osobne wiersze, jeden na przebieg:

- **podstawowy** — postęp, pauza/wznowienie (jak dziś);
- **rozszerzony** — stan modelu (*załadowany* / *niedostępny*, z czasem ostatniej sondy),
  postęp backfillu, bieżąca mediana czasu na klatkę, pauza/wznowienie.

Stan „model niedostępny" jest komunikatem neutralnym, nie błędem — to normalny tryb
pracy, gdy stacja jest wyłączona.

## 9. Konfiguracja

**Przebieg podstawowy — bez zmian.** Istniejące `ACTIVITY_DETECTION_ENABLED`,
`ACTIVITY_SCAN_INTERVAL_SECONDS`, `ACTIVITY_SCAN_BATCH`, `ACTIVITY_SCORE_THRESHOLD`,
`ACTIVITY_PIXEL_THRESHOLD`, `ACTIVITY_COLOR_THRESHOLD` zostają nietknięte. Wyłączenie
przebiegu rozszerzonego nie wymaga dotknięcia żadnej z nich.

**Przebieg rozszerzony — nowe zmienne, wszystkie z przedrostkiem `AI_`:**

| zmienna | domyślnie | uwagi |
|---|---|---|
| `AI_TAGGING_ENABLED` | `false` | **domyślnie wyłączony** — to funkcja opcjonalna; galeria bez niej działa w pełni |
| `AI_LMSTUDIO_URL` | `http://192.168.0.11:1234` | musi być osiągalne z kontenera |
| `AI_MODEL` | `qwen/qwen3-vl-8b` | ten sam napis, którego szuka bramka `state:"loaded"` |
| `AI_PROBE_INTERVAL_SECONDS` | `300` | co ile sprawdzać dostępność modelu, gdy go nie ma |
| `AI_IMAGE_WIDTH` | `1024` | zmierzony punkt optymalny; 1536 px trzykrotnie wydłuża backfill bez zysku |
| `AI_PROMPT_VERSION` | `semantics-v1` | zmiana wyzwala przeliczenie |
| `AI_WEATHER_PROMPT_VERSION` | `weather-v1` | |
| `AI_WEATHER_MIN_GAP_SECONDS` | `600` | odstęp czasowy, nie co N-ta klatka — interwał zapisu zmieniał się przez lata |
| `AI_BATCH` | `200` | klatek na partię; między partiami pętla sprawdza pauzę i dostępność |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | |
| `AI_MAX_FAILURES` | `5` | po tylu nieudanych próbach dla jednej klatki odpuszczamy |

Zwróć uwagę na domyślne `AI_TAGGING_ENABLED=false`: świeże wdrożenie zachowuje się
dokładnie jak dzisiejsze, a przebieg rozszerzony jest świadomym włączeniem.

W LM Studio trzeba włączyć **„Serve on Local Network"** i przepuścić port 1234 w zaporze
Windows. Osiągalność `192.168.0.11:1234` z wnętrza kontenera to punkt do sprawdzenia przy
pierwszym wdrożeniu.

## 10. Testy

**Zbiór referencyjny** (67 klatek z ręcznymi etykietami, zebrany w trakcie pomiarów)
wchodzi do repozytorium jako fixture — same etykiety i ścieżki, bez plików JPEG, które
zostają na NAS-ie. Skrypt `tests/ai/fixtures.ts` pobiera je po LAN przy uruchomieniu.

**Testy jednostkowe** (bez sieci, na atrapach): normalizacja nazw zwierząt, bramka nocna,
wybór klatek do wywołania pogodowego, rozróżnienie awarii transportu od awarii klatki,
logika przeliczania po zmianie `aiPromptVersion`.

**Test regresyjny modelu** (`npm run ai:eval`, uruchamiany ręcznie, wymaga załadowanego
modelu) — przepuszcza zbiór referencyjny i sprawdza progi akceptacji:

| miara | próg |
|---|---|
| osoba — wykryte | ≥ 6/6 |
| osoba — fałszywe alarmy | 0/31 |
| zwierzęta — wykryte | ≥ 6/6 |
| zwierzęta — zmyślone | 0 |
| śnieg padający | 2/2, kontrola nocna `none` |
| gęsta mgła | 2/2 |
| mediana czasu — semantyka | ≤ 2 000 ms |
| mediana czasu — pogoda | ≤ 4 000 ms |

To jest jedyna obrona przed cichą regresją po zmianie polecenia, wersji modelu albo
wersji LM Studio. Bez niej strojenie jest strzelaniem w ciemno — co ten projekt
udokumentował na własnym przykładzie kilka razy.

## 11. Świadome ograniczenia

Rzeczy zmierzone jako niedziałające, **celowo pominięte** w wersji podstawowej:

- **Pojazdy i zmiany stanu (przyjazd/odjazd).** Jeden z pierwotnych celów właściciela.
  Pole `vehicles_count` nie niesie informacji; potrzebne jest osobne opracowanie polecenia
  i walidacja na zbiorze referencyjnym, dokładnie tak jak przy zwierzętach (2/6 → 6/6).
  Do osobnego zadania.
- **Łagodna mgła i granica z zachmurzeniem.** Użyteczny jest wyłącznie sygnał binarny
  „tło zniknęło" (`dense_fog`). Wartości `slight_haze` i `fog` zapisujemy, ale nie
  wystawiamy jako filtr.
- **Deszcz.** Z tej kamery nieweryfikowalny: drobny opad bywa niewidoczny, a model orzeka
  `rain` bez pokrycia w obrazie i robi to stabilnie przez wiele klatek. Zapisujemy, nie
  filtrujemy, nie alarmujemy.
- **Zasłonięcie obiektywu.** Pająki i gałęzie przy obiektywie to najliczniejszy artefakt
  nocny, ale pole modelu jest prawdziwe niemal zawsze. Do osobnego opracowania —
  najpewniej klasycznego (duży, bardzo jasny, zwarty obszar przy krawędzi kadru w trybie IR).

Osobno, poza oprogramowaniem: **w kadrze rosną gałęzie tuż przy obiektywie**, które lampa
podczerwieni rozświetla na pół obrazu. To najliczniejsza klasa nocnych artefaktów w całym
archiwum. Przycięcie ich poprawi detekcję bardziej niż jakakolwiek zmiana w kodzie.

## 12. Koszt

**Przebieg podstawowy** — bez zmian względem dzisiejszego stanu: dziesiątki milisekund
na klatkę na NAS-ie, pomijalne. Ten przebieg nie ma backfillu do nadrobienia, bo działa
od dawna.

**Przebieg rozszerzony** — cały koszt poniżej dotyczy dostępności karty na stacji:

| | czas |
|---|---|
| backfill semantyczny 209 029 klatek | ~78 h ≈ **3,2 doby** pracy karty |
| backfill pogodowy (co 600 s, tylko dzień) | ~24 h ≈ **1 doba** |
| **razem, jednorazowo** | **~4,2 doby** dostępności modelu |
| bieżąco: 576 klatek/dobę + ~72 pogodowe | **~17 min/dobę** |

Backfill rozłoży się na tygodnie, bo stacja nie pracuje bez przerwy — i nie ma powodu,
żeby pracowała. Nadążanie za bieżącym materiałem kosztuje kilkanaście minut dziennie,
więc nowe klatki będą opisane praktycznie od razu, a zaległości nadrabiane w tle.

Obciążenie NAS-a przez przebieg rozszerzony to wyłącznie odczyt pliku i skalowanie do
1024 px — ok. 100 ms na klatkę, czyli tyle co generowanie miniatury. Przy pełnym
backfillu daje to ~6 h pracy procesora rozłożone na te same tygodnie.

## 13. Ryzyka

- **Model nie jest odporny na zmianę sceny.** Polecenie systemowe opisuje konkretne obiekty
  (przyczepa, wiata, łódka), a scena zmieniała się co roku. Przy kolejnej dużej zmianie
  trzeba zaktualizować opis i podnieść `AI_PROMPT_VERSION`. Test regresyjny to wychwyci.
- **Niejednorodne rozdzielczości i tryby zapisu.** Skalowanie do 1024 px z blokadą
  powiększania obsługuje 800×480 bez psucia. Próbkowanie pogody jest oparte na czasie
  właśnie z tego powodu (patrz 4.3) — pozostaje sprawdzić na materiale z 2024, czy serie
  wyzwalane ruchem nie generują nieproporcjonalnie dużo wywołań semantycznych; jeśli tak,
  dojdzie analogiczny minimalny odstęp dla wywołania semantycznego.
- **Zmiana wersji LM Studio lub modelu** może przestawić zachowanie bez ostrzeżenia.
  Stąd zapisywanie `aiModel` przy każdym wyniku i test regresyjny przed przyjęciem zmiany.
- **Stabilność między przebiegami.** Przy wąskim schemacie pięć powtórzeń dawało identyczny
  wynik, ale ta sama klatka w długim ciągu skanowania potrafiła raz odpowiedzieć inaczej.
  Nie blokuje wdrożenia — blokuje traktowanie pojedynczej etykiety jako pewnika.

## 14. Kryteria akceptacji

**Niezależność przebiegów** — to jest wymaganie kluczowe:

1. Przy `AI_TAGGING_ENABLED=false` galeria zachowuje się dokładnie jak dziś: przebieg
   podstawowy skanuje, filtr „ruch w kadrze" działa, grupa filtrów rozszerzonych jest
   wygaszona z czytelną notatką.
2. Przy włączonym przebiegu rozszerzonym i **wyłączonej stacji roboczej** przebieg
   podstawowy pracuje bez zakłóceń; sonda co 300 s nie generuje błędów w logu ani
   nie spowalnia pętli A.
3. Zapauzowanie jednego przebiegu nie wpływa na drugi (test: pauza A, sprawdź że B
   nadal oznacza klatki, i odwrotnie).
4. Wyłączenie modelu w trakcie partii przerywa ją czysto: żadna klatka nie zostaje
   oznaczona jako zeskanowana z pustym wynikiem, postęp nie cofa się.
5. Kolumny przebiegu A nigdy nie zmieniają się wskutek działania pętli B i odwrotnie
   (test na poziomie zapytań SQL).

**Funkcjonalność:**

6. Migracja przechodzi na istniejącej bazie bez utraty danych.
7. Po załadowaniu modelu skanowanie rusza samo, od najnowszych klatek, bez restartu
   kontenera.
8. `npm run ai:eval` przechodzi wszystkie progi z rozdziału 10.
9. Panel filtrów: każdy rodzaj włącza się i wyłącza osobno; zaznaczenie kilku daje sumę;
   brak zaznaczeń pokazuje wszystko; liczniki zgadzają się z liczbą zwróconych klatek.
10. Przełącznik pokrycia poprawnie rozdziela klatki widziane przez przebieg podstawowy,
    rozszerzony, oba i żaden.
11. Filtry „osoba" i „zwierzę" zwracają zbiór zgodny ze zbiorem referencyjnym.
