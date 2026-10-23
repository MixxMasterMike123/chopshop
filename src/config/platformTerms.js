/**
 * Platform-level contract templates — VERBATIM from
 * docs/legal-template-files/04-plattformsvillkor.md and
 * docs/legal-template-files/05-personuppgiftsbitradesavtal.md.
 *
 * These are the B2B documents a merchant must accept in the admin UI before
 * their shop can take payments: the platform terms and the GDPR art. 28 data
 * processing agreement (the DPA is an annex to, and part of, the terms).
 * Distinct from src/config/legalTemplates.js, which holds the CONSUMER-facing
 * pages each shop publishes to its buyers.
 *
 * ⚠️ MANDATORY LEGAL TEXT — do NOT edit the substance here. These are a first
 * draft pending a lawyer's review; every open question is marked inline with a
 * [BEKRÄFTA: …] placeholder. Change the .md source and re-copy, never the
 * other way around.
 *
 * Language: the document CONTENT is Swedish (the merchants are Swedish
 * businesses). The surrounding code is English.
 *
 * Each template is markdown. The leading `# Title` and `*Senast uppdaterad*`
 * lines from the source files are intentionally omitted — the renderer supplies
 * the page <h1> and the last-updated date from render-time data, exactly as it
 * does for legalTemplates.js.
 *
 * Merge fields (filled by the renderer):
 *   {{platform_legal_name}}  — PLATFORM.legalName (src/config/platform.js)
 *   {{platform_org_suffix}}  — " (org.nr NNNNNN-NNNN)" or '' when unregistered
 *   {{last_updated}}         — render time
 */

// Bumped whenever the substance changes. A merchant whose accepted version is
// older than this must re-accept before continuing to use the service
// (plattformsvillkor § 15).
export const PLATFORM_TERMS_VERSION = '2026-09-07';

export const PLATFORM_TERMS_TITLE = 'Plattformsvillkor';
export const PLATFORM_DPA_TITLE = 'Personuppgiftsbiträdesavtal';

export const PLATFORM_TERMS_TEMPLATE = `> **UTKAST – ej granskat av jurist.** Texten är ett första utkast och ska granskas av jurist innan
> den används mot kund.

Dessa villkor gäller mellan {{platform_legal_name}}{{platform_org_suffix}} ("Plattformen", "vi") och
den näringsidkare som öppnar och driver en webbshop på plattformen ChopShop ("Säljaren", "du").

## 1. Parter och tillämpning

Avtalet ingås när Säljaren godkänner dessa villkor i plattformens administrationsgränssnitt.
Godkännandet registreras med tidpunkt, användarkonto och villkorsversion.

Villkoren gäller endast näringsidkare. Plattformen tillhandahålls inte till konsumenter, och
konsumentskyddande regler är därför inte tillämpliga på detta avtal.

Den som godkänner villkoren intygar att han eller hon är behörig företrädare för Säljaren och har
rätt att binda Säljaren vid avtalet.

## 2. Tjänsten

Plattformen tillhandahåller en teknisk tjänst där Säljaren kan skapa och driva en egen webbshop med
produktkatalog, kassa, orderhantering och tillhörande administration.

Utöver grundtjänsten finns tillval (add-ons) som Säljaren kan aktivera, exempelvis print on demand,
påminnelser om övergivna varukorgar, produktrecensioner och rabattkoder. Tillval kan omfattas av
särskilda villkor och särskild prissättning enligt prislistan.

Plattformen utvecklas löpande. Vi får ändra, lägga till och ta bort funktioner. Väsentliga
försämringar av funktioner som Säljaren använder meddelas i rimlig tid i förväg.

## 3. Säljarens roll

Säljaren är säljare och avtalspart gentemot kunden ("merchant of record"). Köpeavtalet ingås direkt
mellan Säljaren och kunden.

Plattformen är teknisk leverantör. Plattformen är inte marknadsplats, inte part i köpet, inte
säljare och inte förmedlare av köpeavtalet.

Säljaren ansvarar fullt ut för:

- produkterna, deras innehåll, kvalitet, märkning och säkerhet,
- priser, prisinformation och rabatter,
- moms, skatter och avgifter samt korrekt redovisning av dessa,
- leverans, leveranstider och fraktvillkor,
- ångerrätt, returer, reklamationer och återbetalningar,
- kundtjänst och kommunikation med kunden,
- bedrägerier, betalningsförluster och chargebacks i den egna butiken, och
- all information som lag kräver att en näringsidkare lämnar till konsument.

## 4. Säljarens material och genererat innehåll

Allt innehåll som Säljaren skapar, laddar upp eller genererar med plattformens verktyg är Säljarens
eget material. Det gäller produkttexter, bilder, motiv, marknadsföring och AI-genererat innehåll,
och det gäller även juridiska texter som skapats från plattformens mallar, såsom köpvillkor,
ångerrättsinformation och integritetspolicy.

Plattformens mallar, guider, checklistor och verktyg är standardformuleringar avsedda som
utgångspunkt. De utgör inte juridisk rådgivning och är inte anpassade till Säljarens verksamhet.

Säljaren ska granska, anpassa och uttryckligen godkänna sådana texter innan butikens kassa öppnas,
och ska vid behov anlita egen juridisk rådgivare. Säljaren ansvarar för att det publicerade
innehållet är riktigt, fullständigt och förenligt med lag.

## 5. Efterlevnad av lag

Säljaren ansvarar för att verksamheten i butiken följer tillämplig lag, däribland:

- konsumentköplagen, distansavtalslagen, prisinformationslagen, marknadsföringslagen,
  e-handelslagen och bokföringslagen,
- dataskyddsförordningen (GDPR) och annan dataskyddslagstiftning,
- regler om produktsäkerhet, produktmärkning och eventuella branschkrav,
- immaterialrätt, så att Säljaren har rätt att använda alla motiv, varumärken, bilder och texter
  som laddas upp eller publiceras, samt
- Stripes vid var tid gällande villkor, inklusive Stripe Connected Account Agreement och Stripes
  förteckning över förbjudna verksamheter och produkter.

## 6. Betalningar via Stripe Connect

Säljaren ska ha ett eget anslutet Stripe-konto (Stripe Express) och genomgå Stripes kontroll av
identitet och verksamhet. Utan godkänt Stripe-konto kan butikens kassa inte öppnas.

Kundens betalning går till Säljarens Stripe-konto. Plattformsavgiften dras som en avgift i samband
med köpet enligt punkt 7.

Utbetalningar sker från Stripe till Säljarens bankkonto enligt Stripes utbetalningsvillkor.
Plattformen tar inte emot, förvarar eller förmedlar kundmedel och ansvarar inte för Stripes
utbetalningar, kontospärrar eller reserveringar.

Återbetalningar, chargebacks, tvistavgifter och andra avdrag belastar Säljarens Stripe-saldo.
Räcker saldot inte till svarar Säljaren för mellanskillnaden.

Säljaren ansvarar för sina egna skatteförhållanden. Plattformen kan vara skyldig att samla in
uppgifter om Säljaren och rapportera ersättning till Skatteverket enligt regler om rapportering från
digitala plattformar (DAC7). Säljaren ska på begäran lämna de uppgifter som krävs för sådan
rapportering.

## 7. Avgifter och prislista

Avgifter för grundtjänsten, tillval och transaktioner framgår av den vid var tid gällande prislistan
i plattformen. Avgifter anges exklusive moms om inget annat anges.

Ändringar av prislistan meddelas Säljaren minst 30 dagar i förväg. Vill Säljaren inte acceptera en
ändring får Säljaren säga upp avtalet till upphörande innan ändringen träder i kraft.

## 8. Print on demand-tillval

Är tillvalet print on demand aktiverat produceras varorna av ett tryckeri som är fristående från
Plattformen. Plattformen förmedlar produktionsordern till tryckeriet och tillhandahåller tekniskt
underlag för tryck.

Säljaren ansvarar för att ha alla nödvändiga rättigheter till de motiv, varumärken och texter som
trycks, och för att motiven inte gör intrång i tredje parts rättigheter eller strider mot lag.

Ansvaret för varans kvalitet, leverans, ångerrätt och reklamation gentemot konsumenten ligger kvar
hos Säljaren, även när produktionen utförs av tryckeriet. Plattformen är inte part i förhållandet
mellan Säljaren och konsumenten och lämnar inga garantier för tryckeriets produktion eller
leveranstider.

Priser för produktion och frakt framgår av prislistan eller av den prissättning som gäller för det
tryckeri som tilldelats butiken.

## 9. Personuppgifter

Säljaren är personuppgiftsansvarig för de personuppgifter som behandlas i butiken, i första hand
uppgifter om kunder och besökare. Plattformen behandlar dessa uppgifter som personuppgiftsbiträde
för Säljarens räkning.

Behandlingen regleras i det personuppgiftsbiträdesavtal som utgör bilaga till dessa villkor och en
integrerad del av avtalet. Vid motstridighet i fråga om behandling av personuppgifter gäller
personuppgiftsbiträdesavtalet före dessa villkor.

## 10. Immateriella rättigheter

Plattformen och allt som ingår i tjänsten, inklusive programvara, gränssnitt, design, mallar och
dokumentation, tillhör {{platform_legal_name}} eller dess licensgivare. Säljaren får en
icke-exklusiv, icke-överlåtbar rätt att använda tjänsten under avtalstiden.

Säljaren behåller alla rättigheter till sitt eget material. Säljaren ger Plattformen en
icke-exklusiv, avgiftsfri licens att lagra, visa, kopiera, anpassa format på och överföra materialet
i den utsträckning det behövs för att leverera tjänsten, inklusive att vidarebefordra tryckunderlag
till tryckeri och visa material i butiken. Licensen upphör när avtalet upphör och materialet
raderats, med undantag för säkerhetskopior under normal gallringstid.

## 11. Tillgänglighet och support

Tjänsten tillhandahålls i befintligt skick. Plattformen gör rimliga ansträngningar för att hålla
tjänsten tillgänglig men lämnar ingen garanti för oavbruten eller felfri drift och har ingen
avtalad servicenivå om inget annat skriftligen överenskommits.

Planerat underhåll förläggs så långt möjligt till tider med låg belastning och aviseras i förväg när
det kan påverka driften.

Support lämnas via de kanaler som anges i plattformen, under normala kontorstider.

## 12. Avstängning och uppsägning

Plattformen får med omedelbar verkan stänga av butiken eller delar av tjänsten vid:

- misstänkt bedrägeri eller annan brottslig verksamhet,
- försäljning av olagliga, förbjudna eller uppenbart rättighetskränkande varor,
- förhöjd nivå av chargebacks eller betalningstvister,
- brott mot Stripes villkor eller beslut av Stripe att avsluta Säljarens konto, eller
- annat väsentligt brott mot dessa villkor.

Avstängning ska stå i rimlig proportion till bristen. Plattformen underrättar Säljaren om orsaken
och, när det är möjligt, om vad som krävs för att avstängningen ska hävas.

Båda parter får säga upp avtalet med 30 dagars varsel utan att ange skäl. Uppsägning sker
skriftligen eller i plattformen.

Säljaren kan under avtalstiden och på begäran inom 30 dagar efter avtalets upphörande få ut sina
produkt-, kund- och orderuppgifter i ett vanligt maskinläsbart format [BEKRÄFTA: exportfunktion
eller manuell utlämning]. Därefter raderas uppgifterna enligt personuppgiftsbiträdesavtalet.

Ordrar som lagts före avtalets upphörande ska fullgöras av Säljaren. Säljaren ansvarar för leverans,
returer och reklamationer avseende sådana ordrar även efter att tjänsten upphört.

## 13. Ansvarsbegränsning

Plattformen ansvarar endast för direkt skada som orsakats genom Plattformens vårdslöshet.

Plattformen ansvarar inte för indirekt skada, såsom utebliven vinst, förlorad omsättning, förlorade
kunder, förlorad data, goodwillskada eller anspråk från tredje part.

Plattformens sammanlagda ansvar under avtalet är begränsat till de avgifter Säljaren betalat till
Plattformen under de tolv månader som föregick den händelse som grundar anspråket.

Begränsningarna gäller inte vid uppsåt eller grov vårdslöshet, eller i övrigt när ansvar inte kan
begränsas enligt tvingande lag.

Anspråk ska framställas skriftligen utan onödigt dröjsmål och senast tolv månader efter att skadan
upptäcktes eller borde ha upptäckts.

## 14. Skadeslöshet

Säljaren ska hålla Plattformen skadeslös för krav, skadestånd, viten, sanktionsavgifter och skäliga
rättegångs- och ombudskostnader som riktas mot Plattformen och som har sin grund i Säljarens butik,
material, produkter, marknadsföring, behandling av personuppgifter eller överträdelse av lag eller
dessa villkor.

Plattformen ska underrätta Säljaren om sådana krav utan onödigt dröjsmål och ge Säljaren rimlig
möjlighet att medverka i hanteringen av kravet.

## 15. Ändringar av villkoren

Plattformen får ändra dessa villkor. Ändringar meddelas i plattformen eller via e-post till den
adress Säljaren angett.

Vid väsentliga ändringar ska Säljaren godkänna den nya versionen i administrationsgränssnittet innan
tjänsten fortsatt får användas. Godkänner Säljaren inte ändringen får avtalet sägas upp enligt
punkt 12.

Varje version av villkoren har ett versionsnummer och ett datum. Den version Säljaren godkänt gäller
till dess en ny version godkänts.

## 16. Övrigt

Säljaren får inte överlåta avtalet utan Plattformens skriftliga samtycke. Plattformen får överlåta
avtalet till ett koncernbolag eller i samband med överlåtelse av verksamheten.

Meddelanden enligt avtalet lämnas i plattformen eller till de e-postadresser parterna angett. Ett
meddelande anses mottaget nästa vardag efter avsändandet.

Är någon bestämmelse i villkoren ogiltig eller overkställbar påverkas inte övriga bestämmelser.
Den ogiltiga bestämmelsen ska ersättas med en giltig bestämmelse som så nära som möjligt motsvarar
den ursprungliga avsikten.

Parterna är självständiga i förhållande till varandra. Avtalet skapar inte något
anställningsförhållande, kommissionsförhållande, agentur eller enkelt bolag.

## 17. Tillämplig lag och tvist

Svensk lag gäller för avtalet, med undantag för lagvalsregler.

Tvist med anledning av avtalet ska avgöras av allmän domstol med Stockholms tingsrätt som första
instans [BEKRÄFTA: forumval, alternativt Säljarens hemvistforum eller skiljeförfarande].
`;

export const PLATFORM_DPA_TEMPLATE = `> **UTKAST – ej granskat av jurist.** Texten är ett första utkast och ska granskas av jurist innan
> den används mot kund.

Detta personuppgiftsbiträdesavtal ("Biträdesavtalet") är en bilaga till plattformsvillkoren och
utgör en integrerad del av avtalet mellan parterna. Biträdesavtalet reglerar Plattformens behandling
av personuppgifter för Säljarens räkning enligt artikel 28 i dataskyddsförordningen (GDPR).

## 1. Parter och roller

Säljaren är personuppgiftsansvarig för de personuppgifter som behandlas i Säljarens webbshop.

{{platform_legal_name}}{{platform_org_suffix}} är personuppgiftsbiträde och behandlar uppgifterna
endast för Säljarens räkning och enligt Säljarens instruktioner.

Biträdesavtalet omfattar inte behandling där Plattformen är personuppgiftsansvarig för egen räkning,
såsom uppgifter om Säljarens egna användarkonton, fakturering och Plattformens säkerhetsloggar.
Sådan behandling regleras i Plattformens egen integritetspolicy.

## 2. Föremål, varaktighet, art och ändamål

**Föremål.** Behandling av personuppgifter som är nödvändig för att tillhandahålla webbshoppen och
de tillval Säljaren aktiverat.

**Varaktighet.** Behandlingen pågår så länge plattformsvillkoren gäller, samt under den tid som
krävs för avslut enligt punkt 8.

**Art.** Insamling, registrering, lagring, strukturering, visning, överföring, ändring, radering och
annan behandling i plattformens system.

**Ändamål.** Att driva Säljarens webbshop: publicera produkter, ta emot och hantera beställningar,
förmedla betalning via Stripe, skicka transaktionsmejl, hantera returer och kundtjänst, samt att
leverera aktiverade tillval såsom print on demand, påminnelser om övergivna varukorgar,
produktrecensioner och rabattkoder.

## 3. Kategorier av registrerade och personuppgifter

**Registrerade:** Säljarens kunder och besökare, mottagare av leveranser, samt personer som
kontaktar Säljarens kundtjänst.

**Personuppgifter:**

- namn och kontaktuppgifter (e-postadress, telefonnummer),
- leverans- och faktureringsadress,
- order- och köphistorik, inklusive produktval och belopp,
- betalningsreferenser och betalstatus (Plattformen lagrar inte fullständiga kortuppgifter),
- innehåll i meddelanden till kundtjänst och i recensioner,
- uppladdat material som kunden själv tillfört, exempelvis motiv eller text på en beställd vara, och
- teknisk information såsom IP-adress, enhets- och webbläsaruppgifter samt loggar.

Behandling av särskilda kategorier av personuppgifter enligt artikel 9 GDPR ingår inte i tjänsten.
Säljaren ska inte föra in sådana uppgifter i plattformen [BEKRÄFTA: hantering om Säljarens
sortiment ändå medför sådana uppgifter, exempelvis hälsorelaterade produkter].

## 4. Biträdets skyldigheter

**Instruktioner.** Plattformen behandlar personuppgifter endast enligt dokumenterade instruktioner
från Säljaren. Plattformsvillkoren, Biträdesavtalet och Säljarens inställningar i
administrationsgränssnittet utgör Säljarens fullständiga instruktioner. Plattformen underrättar
Säljaren om Plattformen anser att en instruktion strider mot dataskyddslagstiftningen. Om lag kräver
behandling utöver instruktionerna underrättar Plattformen Säljaren innan behandlingen, om inte lagen
förbjuder detta.

**Sekretess.** Plattformen säkerställer att personer som får tillgång till personuppgifterna har
åtagit sig sekretess eller omfattas av lagstadgad tystnadsplikt. Åtkomst ges endast till dem som
behöver den för att utföra sina arbetsuppgifter.

**Säkerhet (artikel 32).** Plattformen vidtar lämpliga tekniska och organisatoriska åtgärder,
däribland kryptering av trafik och av lagrade uppgifter, behörighetsstyrning med individuella konton
och rollbaserad åtkomst, logisk separation av data mellan butiker, säkerhetskopiering, loggning av
åtkomst och administrativa åtgärder, sårbarhetshantering samt rutiner för att regelbundet utvärdera
åtgärdernas effektivitet [BEKRÄFTA: fullständig åtgärdsförteckning och eventuella certifieringar].

**Bistånd med registrerades rättigheter.** Plattformen bistår Säljaren med lämpliga tekniska och
organisatoriska åtgärder så att Säljaren kan besvara begäran från registrerade om tillgång,
rättelse, radering, begränsning, invändning och dataportabilitet. Vänder sig en registrerad direkt
till Plattformen hänvisar Plattformen personen till Säljaren och informerar Säljaren.

**Bistånd enligt artiklarna 33 till 36.** Plattformen bistår Säljaren med säkerheten i behandlingen,
anmälan av personuppgiftsincidenter, information till registrerade samt konsekvensbedömningar och
förhandssamråd, i den utsträckning det är rimligt med hänsyn till behandlingens art och den
information Plattformen har tillgång till.

**Radering eller återlämnande.** När tjänsten upphör raderar Plattformen personuppgifterna, eller
återlämnar dem på Säljarens begäran, senast 30 dagar efter avtalets upphörande. Säljaren kan under
avtalstiden och i minst 30 dagar därefter exportera uppgifterna i ett vanligt maskinläsbart format.
Säkerhetskopior raderas enligt normal gallringsrutin, senast [BEKRÄFTA: gallringstid för
säkerhetskopior, exempelvis 90 dagar]. Uppgifter som Plattformen enligt lag måste behålla får
sparas så länge lagen kräver, varvid behandlingen begränsas till lagring.

**Revision.** Plattformen ställer på begäran den information till förfogande som krävs för att visa
att skyldigheterna enligt artikel 28 GDPR uppfylls, och möjliggör och medverkar vid granskning som
utförs av Säljaren eller av en oberoende granskare som Säljaren utsett. Granskning aviseras minst 30
dagar i förväg, sker under normal arbetstid, högst en gång per år om inte en incident eller ett
myndighetsbeslut föranleder annat, och får inte störa driften eller ge insyn i andra kunders
uppgifter. Säljaren står för sina kostnader och ersätter Plattformens skäliga kostnader för
medverkan.

## 5. Underbiträden

Säljaren ger Plattformen ett allmänt förhandstillstånd att anlita underbiträden. Plattformen ingår
skriftligt avtal med varje underbiträde med minst samma skyldigheter som i Biträdesavtalet och
ansvarar för underbiträdets behandling som för sin egen.

Vid ingången av Biträdesavtalet anlitas följande underbiträden:

| Underbiträde | Tjänst | Behandlingsort |
|---|---|---|
| Stripe Payments Europe Ltd, Irland | Betalningar och utbetalningar | EU/EES [BEKRÄFTA: Stripes egen roll som personuppgiftsansvarig för betalningsdata] |
| Google Ireland Ltd (Google Cloud / Firebase) | Hosting, databas och lagring | [BEKRÄFTA: region, exempelvis europe-north1] |
| Cloudflare Inc | CDN och edge-tjänster | [BEKRÄFTA: dataflöden och vilka uppgifter som passerar edge] |
| Resend Inc, USA | Transaktionsmejl | USA [BEKRÄFTA: överföringsmekanism, SCC eller EU-US Data Privacy Framework] |
| Anthropic PBC, USA | AI-genererat innehåll i tillvalet Innehållsstudio | USA [BEKRÄFTA: juridiskt namn, överföringsmekanism och om personuppgifter alls behandlas] |
| Tilldelad tryckeripartner, för butiker med print on demand | Produktion och frakt | [BEKRÄFTA: namn, adress och e-postadress för det tryckeri som tilldelats butiken] |

Plattformen underrättar Säljaren minst 30 dagar i förväg om avsikten att byta eller lägga till ett
underbiträde. Säljaren får inom 15 dagar från underrättelsen invända skriftligen mot ändringen på
sakliga dataskyddsgrunder. Kan parterna inte enas får Säljaren säga upp plattformsvillkoren till
upphörande vid den tidpunkt då ändringen träder i kraft, utan avgift för den återstående tiden.

## 6. Överföring till tredjeland

Personuppgifter behandlas i första hand inom EU/EES. Sker överföring till land utanför EU/EES får
den ske endast om det finns en giltig grund enligt kapitel V GDPR, i första hand EU-kommissionens
standardavtalsklausuler eller ett beslut om adekvat skyddsnivå, kompletterat med de ytterligare
skyddsåtgärder som behövs efter en bedömning av förhållandena i mottagarlandet.

Plattformen dokumenterar vilken mekanism som används för varje överföring och lämnar informationen
till Säljaren på begäran [BEKRÄFTA: aktuell mekanism per underbiträde enligt tabellen i punkt 5].

## 7. Personuppgiftsincidenter

Plattformen underrättar Säljaren utan onödigt dröjsmål efter att ha fått kännedom om en
personuppgiftsincident som rör Säljarens uppgifter, och senast inom [BEKRÄFTA: tidsfrist, exempelvis
48 timmar] från kännedom.

Underrättelsen ska innehålla incidentens art, berörda kategorier och ungefärligt antal registrerade
och uppgifter, sannolika konsekvenser, vidtagna och föreslagna åtgärder samt kontaktuppgift för
ytterligare information. Är all information inte tillgänglig lämnas den i omgångar utan ytterligare
dröjsmål.

Säljaren ansvarar för anmälan till Integritetsskyddsmyndigheten och för eventuell information till
registrerade.

## 8. Ansvar

Vardera parten ansvarar för sin del av behandlingen enligt GDPR. Ansvaret mellan parterna enligt
Biträdesavtalet omfattas av ansvarsbegränsningen i plattformsvillkoren, i den utsträckning
begränsningen är tillåten enligt tvingande lag. Artikel 82 GDPR och sanktionsavgifter enligt
artikel 83 GDPR gäller oberoende av avtalade begränsningar.

## 9. Giltighetstid

Biträdesavtalet gäller så länge Plattformen behandlar personuppgifter för Säljarens räkning, och
upphör när radering eller återlämnande enligt punkt 4 genomförts. Bestämmelser om sekretess,
säkerhet, ansvar och radering fortsätter att gälla så länge uppgifter finns kvar hos Plattformen
eller något underbiträde.

Vid motstridighet mellan Biträdesavtalet och plattformsvillkoren gäller Biträdesavtalet i fråga om
behandling av personuppgifter.
`;
