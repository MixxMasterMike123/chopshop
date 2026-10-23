// Affiliateportalen — Guide (/affiliate/guide; CP13 design §7.1b, §7.3): a
// short text from the platform on how the link works, how posts are marked
// as advertising, and when money is paid. Static; the rates come from
// PortalMe so the text never names a figure the shop did not set.

import React from 'react';
import { Link } from 'react-router-dom';
import { CardSection, Page } from '../../../components/admin/ui';
import { formatBp } from '../../adapters/affiliatePortal.js';
import { usePortal } from './portalContext.js';

function Section({ title, children }) {
  return (
    <CardSection title={title}>
      <div className="max-w-prose space-y-2 leading-relaxed">{children}</div>
    </CardSection>
  );
}

export default function AffiliateGuide() {
  const { affiliate } = usePortal();
  return (
    <Page title="Guide" subtitle="Så fungerar det, i korthet.">
      <div className="space-y-4">
        <Section title="Din länk och din kod">
          <p>
            Dela din länk där din publik finns. Den som klickar på länken får koden {affiliate.code} sparad i varukorgen i upp
            till 30 dagar och får {formatBp(affiliate.discountBp)} rabatt när hen handlar.
          </p>
          <p>
            Koden fungerar också på egen hand: den som skriver in den i kassan får samma rabatt, och köpet räknas till dig. Har
            köparen kommit via en annan affiliates länk gäller den länken.
          </p>
          <p>Länkbesöken på översikten räknas per dag. Vi sparar inget om besökarna.</p>
        </Section>
        <Section title="Märk dina inlägg som reklam">
          <p>
            Enligt marknadsföringslagen måste det synas direkt att ett inlägg är reklam. Skriv till exempel{' '}
            <strong>Reklam</strong> eller <strong>Annons</strong> först i inlägget, i videon och vid länken, inte bara längst ner
            eller bland hashtaggarna.
          </p>
          <p>Beskriv produkterna som de är. Lova inget som butiken inte lovar.</p>
          <p>Köp inte annonser på butikens namn och använd inte din egen kod för egna köp.</p>
        </Section>
        <Section title="När pengarna kommer">
          <p>
            Du får {formatBp(affiliate.commissionBp)} av varuvärdet efter rabatt, exklusive moms och frakt. Provisionen ligger
            under ångerfrist i 14 dagar efter köpet. Om ordern återbetalas minskar provisionen i samma proportion.
          </p>
          <p>
            När beloppet syns under <em>Att betala</em> kan du{' '}
            <Link to="/payouts" className="underline underline-offset-2">
              begära utbetalning
            </Link>{' '}
            och bifoga faktura eller annat underlag. Butiken betalar ut och markerar utbetalningen som betald här. Är du
            privatperson kan ersättningen vara skattepliktig inkomst.
          </p>
        </Section>
      </div>
    </Page>
  );
}
