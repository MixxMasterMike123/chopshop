# Meteor — Säljhandbok

*Internt underlag för Kent · 2026-07-10 · Sammanställt ur plattformens kodbas*
*Detta dokument är för dig som säljer — INTE för att delas med kunder. Det innehåller interna detaljer, prisresonemang och en ärlig lista över vad som inte är klart.*

---

## Pitchen på en mening

> **"En färdig svensk webbutik som kostar när den säljer — inte innan."**

Meteor är en komplett svensk e-handelsplattform: kunden får en färdig webbutik, ett enkelt bakkontor på svenska och tillägg som säljer mer. Kunden behöver aldrig röra Shopify, plugins, engelska supportforum eller en webbyrå.

**Målgrupp (sweet spot):** verksamheter som omsätter under ~200 000 kr/år på nätet. Vår kalkyl (se `docs/JAMFORELSE_SHOPIFY_VS_METEOR.md`) visar att Shopify med nödvändiga appar blir dyrare än Meteor för alla under ca 135–250 tkr/år i omsättning.

---

## Del 1 · Vad plattformen innehåller — de tre pelarna

### 1. Butiken (det kundens kunder ser)
- **4 färdiga designmallar**: NORD (tidlös/redaktionell), Sport (föreningar/klubbar), Molten (streetwear/mörk), Modehus (mode/fotografisk). Byts med ett klick i adminen. Nya mallar är billiga för oss att ta fram — kan säljas som anpassning.
- Produktsidor med **varianter** (färg/storlek, egen bild, eget pris och SKU per variant).
- Samlingar (manuella + smarta/regelstyrda), kategorier, taggar, **egen menybyggare** med mobilmeny.
- Kundvagn, kassa, orderbekräftelse, kundkonton, retursida/ångerflöde.
- Egen logga, favicon, accentfärg och flikrubrik per butik.
- Utvald-sortering på startsidan (butiken väljer och drag-sorterar vad som visas först).

### 2. Motorn (bakkontoret)
- Ordrar, produkter, frakt per land, **Click & Collect** (hämta i butik med datumval) — fraktkostnad nollas vid upphämtning.
- **Betalningar via Stripe** — hela kapitlet i Del 2 nedan. Detta är vår starkaste tekniska story.
- Automatiska mejl med butikens egen avsändare: kvitto, orderstatus, lösenordsåterställning, verifiering — 9 mallar, alla på svenska och avbrandade.
- **Svensk juridik inbyggd**: ångerrätt (14 dagar, eget ångerflöde på sajten), Omnibus-prisregler för rea, marknadsföringssamtycke enligt MFL, DAC7-skatteunderlag (Del 2), cookie-samtycke.
- **Migrering**: engångsimport från Shopify eller WooCommerce (Del 3).

### 3. Tillväxten (tillägg som slås på per butik)
| Tillägg | Vad det gör |
|---|---|
| **Recensioner** | Verifierade köp, automatisk mejlförfrågan 7 dagar efter leverans, auto-publicering med innehållsfilter, stjärnor + Google-strukturdata på produktsidan |
| **Övergiven kassa** | En påminnelse per övergiven kassa med återställningslänk; dubbelt samtycke enligt MFL |
| **Rabattkoder** | Kampanjkoder på hela vagnen eller valda produkter, datumintervall, användningsgräns |
| **Affiliate + Kampanjer + Ambassadörer** | Provisionsprogram, banners, influencer-CRM |
| **Print on demand** | Hela kapitlet i Del 4 — vår mest unika förmåga |
| **Innehållsstudio (AI)** | Butiken laddar upp råmaterial → färdiga TikTok/Reels-inlägg (hook, caption, hashtags) + automatiskt ihopklippt vertikal video |
| **AI-texter** | Claude-genererade produktbeskrivningar |
| **B2B Grossist** | Grossistpriser, återförsäljarinlogg, fakturaköp |

Tilläggen styrs per butik från vår plattformskonsol — vi slår på/av med ett klick. **Det är här paketeringen bor:** samma kodbas, olika paket.

---

## Del 2 · Pengarna — Stripe Connect på djupet

Detta är det viktigaste kapitlet att kunna i kundmöte. Frågan "vem håller mina pengar?" avgör affären.

### Så kopplas en ny butik på betalningar

1. **Vi aktiverar** betalningar för butiken från plattformskonsolen (en flagga per butik). Där sätter vi också butikens **avgift** (se nedan).
2. **Butiksägaren klickar "Aktivera utbetalningar"** på sidan Utbetalningar i sin admin. De skickas till **Stripes egen onboarding** — ett standardiserat KYC-flöde där de anger org.nr eller personnummer, bankkonto och ID-handling.
3. **Klart på ~5–10 minuter.** Statusen synkas automatiskt tillbaka (onboarding → pending → aktiv). Vi ser i konsolen exakt vad som eventuellt saknas hos Stripe.

**Säljpoäng:** Kunden får ett **eget Stripe-konto** (Stripe Express). Det är inte "Meteors konto med kundens pengar på" — det är kundens eget, med Stripes egen kontrollpanel där de ser saldo och utbetalningshistorik. Stripe är samma betalinfrastruktur som Shopify, Kickstarter och Deliveroo använder.

### Pengaflödet per order — exakt så här funkar det

1. Kundens kund betalar i kassan (kort, Apple Pay, Google Pay, Klarna — styrs i Stripe, allt i SEK).
2. Betalningen tas emot på plattformens konto och **skickas automatiskt och omedelbart vidare** till butikens Stripe-konto — **minus plattformsavgiften**. Detta är Stripes "destination charge"-modell: ett enda flöde, ingen manuell hantering, ingen fördröjning från vår sida.
3. Ordern skapas automatiskt när betalningen bekräftats (webhook) — kvittomejl, orderstatus, ev. affiliate-provision och POD-tryckerinotis fyrar i samma sekund.

**Plattformsavgiften:**
- Sätts **per butik** i baspunkter (bps) i vår konsol — fältet "Avgift".
- **Default: 500 bps = 5,0 %** av bruttoordervärdet (inkl. moms).
- Kan alltså differentieras per kund/paket utan kodändring: 3 % för en stor kund, 5 % standard, 7 % för en supportintensiv — bara ett fält.

**Utbetalningar till butiken:**
- **Månadsvis, den 1:a varje månad** till butikens bankkonto (standardschema vi sätter vid skapandet).
- Butiken ser saldo (tillgängligt/på väg/reserverat) direkt i sin Meteor-admin, plus en knapp till Stripes fullständiga panel för historik.
- Vi kan som riskverktyg fördröja utbetalningar för en enskild butik (0–365 dagar) — används bara vid misstänkt risk.

### Återbetalningar, tvister och risk

- **Återbetalning** görs av butiken/oss via en knapp: pengarna dras automatiskt tillbaka från butikens Stripe-saldo och går till köparen. Delåterbetalningar stöds. Policyfråga (plattformsinställning): om vi återbetalar även vår avgift (default) eller behåller den som servicekostnad.
- **Tvister (chargebacks)** hanteras automatiskt: när en tvist öppnas återförs pengarna från butiken så att inte plattformen sitter med risken; vinner butiken tvisten skickas exakt beloppet tillbaka. Förlorade tvister som inte kan återvinnas larmas till oss för manuell hantering.
- **DAC7** (EU:s plattformsskatteregler): vi samlar automatiskt in säljaruppgifter (hämtas från Stripes KYC), aggregerar årsvolymer per butik och tar fram rapportunderlaget. Gränsen för undantag: färre än 30 försäljningar OCH max 2 000 €. **Själva inlämningen till Skatteverket gör vi manuellt** — men kunden behöver inte göra någonting. Säljpoäng mot småföretagare: "skattekrånglet följer med på köpet".

### Vad du kan säga — och inte säga — om betalningar

| Säg | Säg INTE |
|---|---|
| "Pengarna går till ditt eget Stripe-konto, utbetalning varje månad" | "Utbetalning när du vill" (schemat är månadsvis den 1:a) |
| "Kort, Apple Pay, Google Pay och Klarna" | "Swish" — **finns inte ännu**, blockerat hos Stripe. Säg "på väg", lova inget datum |
| "Vi tar X % av försäljningen, inget annat" | Glöm inte att Stripes egen transaktionsavgift (~1,5–2,9 % + fast avgift) dras utöver vår — var transparent om frågan kommer |
| "Tvister och återbetalningar hanteras automatiskt" | "Ni slipper tvister" — de hanteras, de försvinner inte |

---

## Del 3 · Ny butik — från handslag till live

Så här ser leveransen ut i praktiken. Viktigt att kunna för att svara på "hur lång tid tar det?".

### Steg för steg

1. **Provisionering (vi, ~1 minut).** Butiksnamn + webbadress-ID + accentfärg. Butiken finns direkt, med standardfunktioner påslagna och osynlig för Google tills vi säger go.
2. **Katalog (vi eller kunden, timmar–dagar).**
   - Har kunden Shopify eller WooCommerce: **engångsimport med ett klick** — produkter, varianter, priser och bilder hämtas och läggs in automatiskt. Stora kataloger körs i omgångar (importen kan återupptas och hoppar över redan importerat). Ninetone (58 produkter) importerades felfritt.
   - **Importen tar INTE med:** lagersaldon, ordrar, kundregister eller kunddata. Sådant sätts upp på nytt. Överdriv inte här — säg "vi flyttar din katalog", inte "vi flyttar din butik rakt av".
   - Ny verksamhet utan befintlig butik: produkterna läggs in för hand i adminen (enkelt, svensk UI).
3. **Utseende (vi + kunden, en timme).** Välj mall, ladda upp logga/favicon, sätt färger, bygg menyn, skriv sidorna (Om oss, villkor — redigerbara CMS-sidor).
4. **Betalningar (kunden, ~10 min).** Stripe-onboarding enligt Del 2. Detta är kundens enda "pappersarbete".
5. **GO LIVE (vi, ett klick).** Tills dess är butiken fullt fungerande via direktlänk (bra för demo!) men markerad så att sökmotorer inte indexerar den. Vid go-live släpps den fri.

**Realistisk tidslinje att lova: några dagar till en vecka**, där kundens egen insats är under en timme plus Stripe-registreringen.

**Demo-tips:** eftersom en oprovisionerad butik tar en minut att skapa och en Shopify-import är ett klick, kan vi sätta upp en demo-butik **med kundens egna produkter** inför ett andra möte. Det säljer bättre än alla slides.

---

## Del 4 · Print on demand — tillägget på djupet

POD är vår mest unika förmåga och primära affärsvertikal. Här finns ingen svensk konkurrent i samma prisklass. Men det är också kapitlet med flest nyanser — läs "vad du inte får lova" noga.

### Konceptet i en mening
Butiken säljer tryckta plagg **utan lager och utan risk**: designen görs en gång, plagget trycks först när någon beställt, och tryckeriet får produktionsfilerna automatiskt.

### Designstudion — butikens verktyg (VIKTIGT: inte slutkundens)

Det här missförstås lätt, så var noggrann i pitchen:

- **Butiksägaren** (eller vi, som tjänst) designar produkten i studion: laddar upp tryckmotiv, placerar det på plagget med millimeterprecision, ser resultatet **live i 3D** — motivet följer plaggets veck och skuggor via en fotorealistisk 3D-vy.
- Studion genererar automatiskt produktbilder (mockups) per färgvariant och publicerar med ett klick en färdig produkt i butiken, med varianter och tryckkopplingar klara.
- **Slutkunden designar INTE själv.** Kunden köper färdigdesignade produkter. Det finns inget "rita din egen tröja"-verktyg. Om en prospect vill ha det: säg att det ligger på roadmap, lova inget datum.
- Plaggbiblioteket (vilka plagg som finns att designa på) hanteras av oss på plattformsnivå: varje plagg kräver foto + kalibrering per färg. Nya plagg är alltså en plattformsleverans — kul säljmöjlighet ("vi lägger in era hoodies"), men det är vårt jobb, inte kundens. 3D-vyn visar i v1 plaggets **framsida**; tryck på rygg/ärm stöds i produktionen men utan 3D-förhandsvisning.

**Juridisk finess som är en säljpoäng:** studioprodukter räknas som katalogvaror, inte personaliserade — därmed behåller slutkunden full 14 dagars ångerrätt och butiken slipper gränsdragningsdiskussioner. (Plattformen har samtidigt fullt stöd för äkta personaliserade flöden med ångerrättsundantag den dagen det behövs.)

### Tryckeriflödet — vad som händer efter köpet

1. Order betalas → **tryckeriet får automatiskt ett mejl** ("Ny POD-order") i samma ögonblick.
2. Tryckeriet loggar in i sin **egen tryckportal** (separat inlogg, kan hantera flera butiker). Där ser de bara det de behöver: leveransadress, produkt/variant/antal, tryckplacering ("Bröst — centrerat") och **produktionsfilen i original** via en säker nedladdningslänk som bara lever i 30 minuter. Inga kunduppgifter utöver adressen — ingen e-post, inget telefonnummer, inga belopp. (Bra GDPR-story.)
3. Tryckeriet uppdaterar status: **Tryckt** (internt) → **Skickad** (med spårningsnummer). Vid Skickad går automatiskt ett leveransmejl till slutkunden, och recensionsförfrågan schemaläggs.
4. Upphämtningsordrar (Click & Collect) markeras särskilt — de lämnas till butiken, inte till slutkund.

**Kvalitetskontroll:** varje uppladdat tryckmotiv valideras automatiskt mot tryckprofiler (upplösning/DPI, filformat, filstorlek, transparens) och märks Godkänd/Varning/Underkänd. Märkningen är rådgivande — tryckeriet ser den och fattar sista beslutet. Säg "automatisk kvalitetskontroll av tryckfiler", inte "garanterat tryckbar".

### Pengarna i POD — läs noga

- **Prismodell (vår rekommendation, ej låst):** POD-funktionen i sig är gratis att slå på. Intäkten ligger i trycket: **~30 % marginal per tryck, minst 40 kr**, plus den vanliga plattformsavgiften på försäljningen.
- **Tryckeriets ersättning hanteras manuellt i dag.** Betalflödet är tvåparts (kund → butik minus vår avgift). Det finns ingen automatisk tredelning kund/tryckeri/plattform — tryckeriet faktureras/avräknas vid sidan av. Fullt hanterbart för de första kunderna, men **lova aldrig "automatisk utbetalning till tryckeriet"**. Trevägssplitten är nästa byggsten.
- Det finns heller inget avräkningsmejl till tryckeriet och inget automatiskt mejl till tryckeriet om en order i kön makuleras/återbetalas — bevaka manuellt vid återbetalning av POD-ordrar.

### POD-pitchen per kundtyp

- **Kreatören/varumärket:** "Designa i webbläsaren, se plagget i 3D innan du publicerar, sälj utan att köpa in ett enda plagg."
- **Föreningen/klubben:** "Klubbshop utan kartonger med osålda hoodies i klubbstugan. Trycks när någon beställer."
- **Befintlig butik:** "Lägg till en merch-linje utan lagerrisk — vi sätter upp designerna åt er."

---

## Del 5 · Säljargument och invändningar

### De tre argumenten

1. **Billigare än Shopify.** Shopify kostar från dag ett: månadsavgift + appar för recensioner/kassaräddning/rabatter + tema + byrå. Hos oss ingår allt, och grundmodellen kan vara "betala när du säljer". Brytpunkten ligger vid ca 135–250 tkr/år — över det är Shopify konkurrenskraftigt, under det vinner vi. Sälj inte mot stora bolag.
2. **Svenskt på riktigt.** Hela adminen på svenska. Ångerrätt, Omnibus, marknadsföringssamtycke, DAC7 — inbyggt, inte kundens problem. Inte ett översatt amerikanskt verktyg.
3. **Vi gör jobbet.** Vi sätter upp butiken, importerar katalogen, väljer mall. Supporten kan logga in i kundens butik och fixa direkt (med spårbar logg) i stället för att hänvisa till ett hjälpcenter.

### Invändningar du kommer möta

| Invändning | Svar |
|---|---|
| "Vem håller mina pengar?" | "Du. Eget Stripe-konto i ditt namn, utbetalning till din bank varje månad. Vi tar bara vår procent per försäljning — automatiskt, transparent." |
| "Vad händer om ni försvinner?" | "Dina pengar ligger hos Stripe, inte hos oss. Din produktdata kan exporteras. Och vi bygger detta som långsiktig affär med betalande kunder från dag ett." |
| "Jag har redan en Shopify/WooCommerce" | "Vi flyttar din katalog med ett klick — produkter, varianter, priser, bilder. Du ser din egen butik i Meteor innan du bestämmer dig." (Demo-tricket från Del 3.) |
| "Kan kunderna betala med Swish?" | "Kort, Apple Pay, Google Pay och Klarna i dag. Swish är på väg." **Inget datum.** |
| "Kan jag ha min egen domän?" | Ärligt svar: inte ännu — butiken ligger på vår adress. Säg "din egen butik", inte "din egen domän". På roadmap. |
| "Vad kostar det egentligen totalt?" | Vår avgift + Stripes transaktionsavgift (~1,5–2,9 % + fast öresavgift). Var öppen med båda — jämför gärna med Shopifys stack där månadskostnaden tillkommer ovanpå samma transaktionsavgifter. |

---

## Del 6 · Paketförslag — Start, Handel, Studio

Nivåerna följer pelarna. Siffrorna är utgångsbud att räkna på tillsammans, inte beslut.

| | **Meteor Start** | **Meteor Handel** | **Meteor Studio** |
|---|---|---|---|
| Tanke | Kom ut på nätet | Sälj mer av det du har | Sälj sådant som inte finns än |
| Innehåll | Butik + valfri mall, produkter/varianter, kassa, ordrar, frakt/Click & Collect, mejl, kundkonton, uppsättning + import | Start **+** recensioner, övergiven kassa, rabattkoder, kampanjer/affiliate, prioriterad support | Handel **+** POD med designstudio & 3D, tryckeriflöde, AI-innehåll (sociala inlägg, video, produkttexter) |
| Fast avgift | 0–295 kr/mån | 495–795 kr/mån | 795–995 kr/mån |
| Rörligt | 5 % av försäljningen | 3–5 % av försäljningen | som Handel + ~30 % marginal per tryck (min 40 kr) |

**Tre intäktsben oavsett paketnamn:** fast månadsavgift (förutsägbarhet), procent på försäljningen (vi växer med kunden), marginal per POD-tryck (skalar utan supportkostnad). Procentsatsen är ett fält per butik i vår konsol — paketen kräver ingen utveckling för att prissättas olika.

**Praktiskt just nu:** tilläggen slås på/av manuellt av oss och månadsavgifter faktureras manuellt — det finns ingen självbetjänad betalvägg. Helt OK för de första 10–20 kunderna, men sälj inte "uppgradera själv med ett klick".

---

## Del 7 · Gör-inte-listan — vad som inte får lovas

Kort och kallt, för att skydda affären:

1. **Ingen Swish** (blockerat hos Stripe tills vidare) — säg "på väg", aldrig datum.
2. **Ingen egen domän** ännu — butiken ligger på plattformens adress.
3. **Ingen kunddesigner** — slutkunden ritar inte egna tryck; butiken designar, kunden köper.
4. **Ingen automatisk tryckeribetalning** — trevägssplitten är inte byggd; avräkning mot tryckeri sker manuellt.
5. **Migrering = katalogen, inte allt** — lager, ordrar och kundregister följer inte med.
6. **Ingen självbetjänad paketdebitering** — månadsavgifter faktureras manuellt tills vidare.
7. **3D-vyn visar framsidan** — rygg-/ärmtryck produceras men förhandsvisas inte i 3D.
8. **Utbetalningsschema är månadsvis den 1:a** — inte "när du vill".

---

## Om du bara hinner säga en sak

> **"Du får en färdig svensk webbutik med pengarna på ditt eget konto — och den kostar när den säljer, inte innan."**

Tre pelare bevisar det. Tre kundtyper köper det. Tre paket prissätter det.
