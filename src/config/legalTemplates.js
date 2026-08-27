/**
 * Per-shop legal page templates — VERBATIM from docs/legal-template-files/.
 *
 * These are the consumer-facing legal pages every shop must publish, so a
 * seller doesn't have to write their own legal text. The renderer
 * (src/utils/legalPageRenderer.js) fills the {{merge_fields}} from the shop's
 * storeIdentity + platform config and evaluates the [[IF ...]] conditionals.
 *
 * ⚠️ MANDATORY LEGAL TEXT — do NOT edit the substance here. These are a
 * first draft pending a lawyer's review (see docs/legal-template-files/README.md).
 * The privacy-policy controller wording is left EXACTLY as drafted, pending
 * legal sign-off — do not invent an alternative model.
 *
 * Language: the page CONTENT is Swedish (buyers are Swedish consumers). The
 * surrounding code is English.
 *
 * Each template is markdown. The leading `# Title` and `*Senast uppdaterad*`
 * lines from the source files are intentionally omitted — the renderer supplies
 * the page <h1> and the last-updated date from render-time data.
 *
 * Conditionals (evaluated by the renderer):
 *   [[IF company]] … [[ELSE]] … [[END]]            — seller is a company vs individual
 *   [[IF vat_registered]] … [[ELSE]] … [[END]]     — seller charges VAT vs not
 *   [[IF pod]] … [[ELSE]] … [[END]]                — shop has the print-on-demand
 *     add-on (shops/{id}.features.pod) vs a things shop. Keeps print vocabulary
 *     ("Print on Demand", "sprucket tryck", and the tryckeri as a GDPR data
 *     recipient) out of a non-POD shop's public pages. The [[ELSE]] branches are
 *     legally EQUIVALENT — same rights, deadlines and contact routes, neutral
 *     wording only. Never let the two branches differ in substance.
 *
 * Merge fields (filled by the renderer): see MERGE_FIELDS below.
 */

// Slugs are the URL paths used on the storefront + footer links. They map
// 1:1 to the three templates. Keep in sync with ShopFooter + DynamicRouteHandler.
export const LEGAL_SLUGS = {
  KOPVILLKOR: 'legal/kopvillkor',
  ANGERRATT: 'legal/angerratt-och-returer',
  INTEGRITETSPOLICY: 'legal/integritetspolicy',
};

// The merge fields each template may reference, with where they come from.
// Used by the renderer + the readiness gate. `required` means a live shop
// can't publish correct pages until it's set.
export const MERGE_FIELDS = {
  shop_name: { source: 'storeIdentity.shopName' },
  seller_legal_name: { source: 'storeIdentity.legalName' },
  seller_address: { source: 'storeIdentity.address' },
  contact_email: { source: 'storeIdentity.supportEmail' },
  org_number: { source: 'storeIdentity.orgNumber', companyOnly: true },
  vat_number: { source: 'storeIdentity.vatNumber', vatRegisteredOnly: true },
  return_address: { source: 'storeIdentity.returnAddress', required: true },
  platform_legal_name: { source: 'PLATFORM.legalName' },
  // Renders " (org.nr NNNNNN-NNNN)" when PLATFORM.orgNumber is set, else '' —
  // so an unregistered platform never prints a broken "(org.nr )" in live text.
  platform_org_suffix: { source: 'PLATFORM.orgNumber' },
  // Optional extra bullet "\n- Telefon: …" appended after the e-post line when
  // storeIdentity.phone is set (Konsumentverket lists phone among trader
  // contact info); empty string when unset so the list stays intact.
  seller_phone_item: { source: 'storeIdentity.phone' },
  last_updated: { source: 'render time' },
};

export const KOPVILLKOR_TEMPLATE = `# Köpvillkor – {{shop_name}}

*Senast uppdaterad: {{last_updated}}*

Dessa köpvillkor gäller när du som kund handlar i webbshoppen {{shop_name}}. Läs igenom dem innan
du genomför ett köp. Genom att slutföra ett köp godkänner du villkoren.

## 1. Säljare

Säljare och din avtalspart för köp i denna webbshop är:

[[IF company]]
- {{seller_legal_name}}
- Organisationsnummer: {{org_number}}
[[IF vat_registered]]- Momsregistreringsnummer: {{vat_number}}[[END]]
- Adress: {{seller_address}}
- E-post: {{contact_email}}{{seller_phone_item}}
[[ELSE]]
- {{seller_legal_name}}
- Adress: {{seller_address}}
- E-post: {{contact_email}}{{seller_phone_item}}
[[END]]

Webbshoppen drivs på en teknisk plattform som tillhandahålls av
{{platform_legal_name}}{{platform_org_suffix}}. Plattformen är endast teknisk leverantör och är inte säljare,
avtalspart eller ansvarig för köpet. Allt ansvar för varorna, leveransen och kundrelationen
ligger hos säljaren ovan.

## 2. Beställning och avtal

När du lägger en beställning får du en orderbekräftelse till din e-post. Avtal om köp anses ingått
när säljaren bekräftat din beställning. Kontrollera att uppgifterna i bekräftelsen stämmer och
kontakta oss omgående om något är fel.

För att handla behöver du vara myndig eller ha målsmans tillstånd.

## 3. Priser och moms

Priserna som anges i webbshoppen gäller vid beställningstillfället.

[[IF vat_registered]]
Alla priser anges i svenska kronor (SEK) inklusive moms. Tillämplig moms specificeras på kvittot.
[[ELSE]]
Alla priser anges i svenska kronor (SEK). Säljaren är inte momsregistrerad, och moms tillkommer
därför inte på köpet.
[[END]]

Eventuell fraktkostnad tillkommer och visas tydligt i kassan innan du genomför köpet.

## 4. Betalning

Betalning sker via vår betaltjänstleverantör i kassan. De betalsätt som erbjuds visas i kassan.
Betalningen hanteras av betaltjänstleverantören enligt deras villkor; säljaren och plattformen
lagrar inte dina fullständiga kortuppgifter.

## 5. Leverans

Leveranssätt, leveranstid och fraktkostnad visas i kassan. [[IF pod]]Om en vara tillverkas eller trycks
efter beställning (Print on Demand) tillkommer produktionstid utöver leveranstiden; den beräknade
tiden anges för produkten eller i kassan.[[ELSE]]Om en vara tillverkas efter beställning tillkommer
produktionstid utöver leveranstiden; den beräknade tiden anges för produkten eller i kassan.[[END]]

När din order har skickats får du, när det är möjligt, leveransinformation och eventuellt
spårningsnummer. Om en leverans blir väsentligt försenad kontaktar vi dig.

Om en vara skadas under transport eller inte kommer fram, kontakta oss så hjälper vi dig.

## 6. Ångerrätt

Som konsument har du som huvudregel 14 dagars ångerrätt enligt distansavtalslagen. Ångerfristen
börjar löpa den dag du tar emot varan.

**Undantag vid personligt anpassade varor.** Ångerrätten gäller inte för varor som har tillverkats
enligt dina egna anvisningar eller fått en tydlig personlig prägel, till exempel om du laddat upp
en egen bild, angett egen text eller beställt efter egna mått. För sådana varor framgår det tydligt
på produktsidan och i kassan att ångerrätt inte gäller, och du får bekräfta detta innan köpet.

Väljer du däremot enbart bland de standardalternativ som erbjuds (till exempel storlek eller färg
på en befintlig produkt) har du full ångerrätt, även om varan tillverkas efter beställning.

**Så här ångrar du köpet.** Enklast ångrar du dig via funktionen "Ångra avtalet här", som du
hittar i sidfoten på alla sidor i webbshoppen — där bekräftar du ångret och får ett
mottagningsbevis direkt. Du kan också meddela oss via e-post till {{contact_email}} eller använda
Konsumentverkets standardblankett för ånger; inget särskilt format krävs. När du ångrat ska du
skicka tillbaka varan utan onödigt dröjsmål och senast 14 dagar efter att du meddelat oss.

**Återbetalning.** När du utnyttjat ångerrätten betalar vi tillbaka vad du betalat, inklusive
ordinarie fraktkostnad, senast 14 dagar efter att vi tagit emot ditt meddelande. Vi kan vänta med
återbetalningen tills vi fått tillbaka varan eller du visat att den skickats tillbaka.

**Returkostnad och varans skick.** Du står för returfrakten när du ångrar ett köp. Du ansvarar för
varans värdeminskning om den hanterats mer än vad som behövts för att bedöma den.

Mer information finns på sidan "Ångerrätt & returer".

## 7. Reklamation (fel på varan)

Reklamation gäller alltid och är skild från ångerrätten. Som konsument har du enligt
konsumentköplagen rätt att reklamera fel på en vara i upp till tre år. Reklamera inom skälig tid
efter att du upptäckt felet; reklamation inom två månader anses alltid ha skett i tid.

Är det fel på varan – till exempel trasig produkt, missfärgning, [[IF pod]]felaktigt eller sprucket tryck,
fel storlek mot angiven måttguide, [[ELSE]]fel storlek mot angiven produktbeskrivning, [[END]]eller fel produkt – kontakta oss på {{contact_email}} med
ordernummer och gärna en bild. Vid godkänd reklamation åtgärdar vi felet utan kostnad för dig,
genom ny vara, rättelse eller återbetalning.

Att du valt fel storlek bland korrekt angivna standardstorlekar är inte ett fel, men kan omfattas
av ångerrätten enligt punkt 6.

## 8. Returer

Vid retur (ånger eller godkänd reklamation) skickar du varan till:

{{return_address}}

Ange alltid ditt ordernummer. Packa varan så att den inte skadas under returtransporten.

## 9. Om vi inte kommer överens

Om du inte är nöjd och vi inte hittar en lösning tillsammans kan du vända dig till Allmänna
reklamationsnämnden (ARN), Box 174, 101 23 Stockholm, www.arn.se. Vi följer ARN:s
rekommendationer. Handlar du från ett annat EU-land hittar du nationella tvistlösningsorgan via
EU:s lista: consumer-redress.ec.europa.eu/dispute-resolution-bodies.

## 10. Force majeure

Säljaren ansvarar inte för förseningar eller hinder att fullgöra köpet som beror på omständigheter
utanför säljarens rimliga kontroll, såsom myndighetsåtgärd, strejk, naturhändelse, omfattande
driftstörning eller liknande. Detta påverkar inte dina tvingande rättigheter som konsument.

## 11. Ändringar av villkoren

Vi kan komma att uppdatera dessa köpvillkor. Den version som gällde när du genomförde ditt köp är
den som gäller för det köpet.

## 12. Kontakt

{{seller_legal_name}}
E-post: {{contact_email}}
[[IF company]]Organisationsnummer: {{org_number}}[[END]]
`;

export const ANGERRATT_TEMPLATE = `# Ångerrätt & returer – {{shop_name}}

*Senast uppdaterad: {{last_updated}}*

Här förklarar vi dina möjligheter att ångra ett köp, reklamera fel och returnera en vara. Dina
rättigheter som konsument enligt distansavtalslagen och konsumentköplagen gäller alltid, oavsett
vad som står här.

## Ångerrätt – 14 dagar

Du har som huvudregel 14 dagars ångerrätt. Fristen räknas från den dag du tar emot varan. Du
behöver inte ange något skäl för att ångra dig.

### När gäller ångerrätten inte?

Ångerrätten gäller inte för varor som tillverkats särskilt för dig – det vill säga varor som
gjorts enligt dina egna anvisningar eller fått en tydlig personlig prägel. Exempel: du har laddat
upp en egen bild, skrivit en egen text eller beställt efter egna mått.

På sådana produkter står det tydligt redan på produktsidan och i kassan att ångerrätt inte gäller,
och du får bekräfta det innan du betalar.

Har du i stället bara valt bland färdiga alternativ i shoppen (till exempel storlek eller färg på
en befintlig [[IF pod]]design[[ELSE]]produkt[[END]]) har du full ångerrätt – även om varan [[IF pod]]trycks eller [[END]]tillverkas efter din
beställning.

### Så ångrar du

1. Meddela oss inom 14 dagar att du vill ångra köpet. Enklast använder du funktionen
   "Ångra avtalet här" i sidfoten på alla sidor i webbshoppen – du får då ett mottagningsbevis
   direkt. Du kan också mejla {{contact_email}} eller använda Konsumentverkets ångerblankett;
   inget särskilt format krävs.
2. Skicka tillbaka varan utan onödigt dröjsmål, senast 14 dagar efter att du meddelat oss.
3. Du betalar returfrakten.

### Återbetalning

Vi betalar tillbaka vad du betalat, inklusive ordinarie fraktkostnad, senast 14 dagar efter att vi
fått ditt meddelande om att du ångrar köpet. Vi kan vänta med återbetalningen tills vi fått
tillbaka varan, eller tills du visat att den skickats tillbaka.

Tänk på att du ansvarar för varans värdeminskning om den hanterats mer än vad som behövts för att
bedöma dess egenskaper och funktion.

## Reklamation – om något är fel

Reklamation är något annat än ångerrätt och gäller alltid. Du har rätt att reklamera fel på en
vara i upp till tre år enligt konsumentköplagen. Reklamera inom skälig tid efter att du upptäckt
felet – inom två månader räknas alltid som i tid.

Exempel på fel du kan reklamera: trasig produkt, missfärgning, [[IF pod]]snett eller sprucket tryck, tryck
som lossnar, [[END]]fel produkt, eller mått som avviker från [[IF pod]]vår storleksguide[[ELSE]]vår produktbeskrivning[[END]].

Så reklamerar du: kontakta oss på {{contact_email}} med ditt ordernummer och gärna en bild på
felet. Vid godkänd reklamation åtgärdar vi det utan kostnad för dig – med ny vara, rättelse eller
återbetalning.

Obs: att du valt fel storlek bland korrekt angivna standardstorlekar räknas inte som ett fel, men
kan omfattas av ångerrätten ovan.

## Returadress

Skicka returer (både ånger och godkänd reklamation) till:

{{return_address}}

Ange alltid ditt ordernummer, och packa varan så att den inte skadas under transporten.

## Om vi inte kommer överens

Hör alltid av dig till oss först – vi vill att du ska bli nöjd. Om vi ändå inte hittar en lösning
kan du vända dig till Allmänna reklamationsnämnden (ARN), www.arn.se, Box 174, 101 23 Stockholm.
Vi följer ARN:s rekommendationer.

## Kontakt

{{seller_legal_name}}
E-post: {{contact_email}}
`;

export const INTEGRITETSPOLICY_TEMPLATE = `# Integritetspolicy – {{shop_name}}

*Senast uppdaterad: {{last_updated}}*

Din integritet är viktig för oss. Här beskriver vi hur dina personuppgifter behandlas när du
handlar i eller besöker webbshoppen {{shop_name}}.

## 1. Personuppgiftsansvarig

Personuppgiftsansvarig för behandlingen av dina personuppgifter i denna webbshop är säljaren:

[[IF company]]
- {{seller_legal_name}}, org.nr {{org_number}}
- Adress: {{seller_address}}
- E-post: {{contact_email}}{{seller_phone_item}}
[[ELSE]]
- {{seller_legal_name}}
- Adress: {{seller_address}}
- E-post: {{contact_email}}{{seller_phone_item}}
[[END]]

Webbshoppen drivs på en teknisk plattform som tillhandahålls av
{{platform_legal_name}}{{platform_org_suffix}}. Plattformen behandlar personuppgifter för säljarens räkning som
personuppgiftsbiträde, enligt ett personuppgiftsbiträdesavtal.

## 2. Vilka personuppgifter vi behandlar

Vi behandlar de uppgifter du lämnar och som uppstår när du handlar, till exempel:
- namn och kontaktuppgifter (e-post, telefonnummer),
- leverans- och faktureringsadress,
- orderinformation och köphistorik,
- betalningsrelaterade referenser (vi lagrar inte dina fullständiga kortuppgifter – de hanteras av
  vår betaltjänstleverantör),
- meddelanden och kontakt med kundtjänst,
- teknisk information såsom IP-adress och enhetsuppgifter när du använder webbshoppen.

## 3. Varför vi behandlar uppgifterna och med vilken rättslig grund

- För att fullgöra köpet och leverera din beställning – rättslig grund: fullgörande av avtal.
- För att hantera betalning, returer, reklamationer och kundtjänst – fullgörande av avtal samt
  vårt berättigade intresse av att hjälpa dig.
- För att uppfylla rättsliga skyldigheter, t.ex. bokföring – rättslig förpliktelse.
- För att förebygga bedrägeri och skydda webbshoppen – berättigat intresse.
- För marknadsföring, t.ex. nyhetsbrev – ditt samtycke, som du när som helst kan återkalla.

## 4. Vilka som kan ta del av uppgifterna

Vi delar uppgifter endast när det behövs, med:
- plattformsleverantören {{platform_legal_name}} (personuppgiftsbiträde som driver webbshoppen),
- vår betaltjänstleverantör (hanterar betalningen enligt sina egna villkor),
[[IF pod]]- tryckeri/produktionspartner och fraktbolag (för att tillverka och leverera din order),[[ELSE]]- fraktbolag (för att leverera din order),[[END]]
- bokförings- och redovisningstjänster samt, vid behov, myndigheter när lag kräver det.

Dessa parter får endast behandla uppgifterna för angivna ändamål.

## 5. Hur länge vi sparar uppgifterna

Vi sparar dina uppgifter så länge det behövs för ändamålen ovan. Uppgifter som krävs enligt
bokföringslagen sparas i sju år. Uppgifter för marknadsföring sparas tills du återkallar ditt
samtycke. Därefter raderas eller anonymiseras uppgifterna.

## 6. Överföring till tredje land

Vi strävar efter att behandla dina uppgifter inom EU/EES. Om någon leverantör behandlar uppgifter
utanför EU/EES sker det endast med lagligt stöd, till exempel EU-kommissionens
standardavtalsklausuler eller annan giltig skyddsåtgärd.

## 7. Dina rättigheter

Du har rätt att:
- få veta vilka uppgifter vi behandlar om dig (registerutdrag),
- få felaktiga uppgifter rättade,
- få uppgifter raderade ("rätten att bli bortglömd"),
- begära begränsning av behandlingen,
- invända mot viss behandling,
- få ut dina uppgifter i ett maskinläsbart format (dataportabilitet), och
- återkalla ett lämnat samtycke.

För att utöva dina rättigheter, kontakta oss på {{contact_email}}. Vi besvarar din begäran utan
onödigt dröjsmål.

## 8. Klagomål

Om du anser att vi behandlar dina personuppgifter felaktigt kan du lämna klagomål till
Integritetsskyddsmyndigheten (IMY), www.imy.se.

## 9. Cookies

Webbshoppen kan använda cookies och liknande tekniker. Information om vilka cookies som används och
dina val kring dessa lämnas via webbplatsens cookie-funktion.

## 10. Kontakt

{{seller_legal_name}}
E-post: {{contact_email}}
[[IF company]]Org.nr: {{org_number}}[[END]]
`;

// Map slug → { template, pageType (for SEO), titleKey }. The renderer + the
// DynamicPage integration use this to resolve a slug to its template.
export const LEGAL_PAGES = {
  [LEGAL_SLUGS.KOPVILLKOR]: {
    template: KOPVILLKOR_TEMPLATE,
    pageType: 'terms',
    title: 'Köpvillkor',
  },
  [LEGAL_SLUGS.ANGERRATT]: {
    template: ANGERRATT_TEMPLATE,
    pageType: 'returns',
    title: 'Ångerrätt & returer',
  },
  [LEGAL_SLUGS.INTEGRITETSPOLICY]: {
    template: INTEGRITETSPOLICY_TEMPLATE,
    pageType: 'privacy',
    title: 'Integritetspolicy',
  },
};

// True if the slug is one of the auto-generated legal pages.
export const isLegalSlug = (slug) => Boolean(LEGAL_PAGES[slug]);
