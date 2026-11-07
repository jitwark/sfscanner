import { ContactValue, LegalSection, RequestChecklist } from './legal-page';
import { dmcaAgent, dmcaAgentIsPublished } from './legal-contacts';
import { ContactEmail, PublicRequestLink } from './takedown-contact';

/**
 * DMCA copyright removal, and the counter-notice that answers it.
 *
 * 17 U.S.C. 512(c)(2) conditions the safe harbour on publishing the designated
 * agent's name, address, phone and email in a publicly accessible location and
 * registering the same with the Copyright Office. Until `legal-contacts.ts` is
 * filled, this section says so rather than implying a protection that is not
 * in place.
 */
export function TakedownCopyright() {
  const published = dmcaAgentIsPublished();
  return (
    <>
      <LegalSection id="copyright" heading="Copyright removal">
        <p>
          If you hold copyright in a workflow catalogued here, or in a repository it was drawn
          from, you can ask for it to be taken down. Send a notice containing all six of the
          following. A notice missing required information may not qualify as an effective
          statutory notification, and we may ask for clarification before evaluating it.
        </p>
        <RequestChecklist
          items={[
            'Your physical or electronic signature, as the copyright owner or someone authorised to act for them.',
            'Identification of the copyrighted work you say has been infringed.',
            'The catalogue URL or stable entry ID of the material to be removed, specific enough to locate it.',
            'Your contact details: address, telephone number and email.',
            'A statement that you believe in good faith that the use is not authorised by the copyright owner, its agent, or the law.',
            'A statement that the information in the notice is accurate, and — under penalty of perjury — that you are authorised to act for the copyright owner.',
          ]}
        />

        <div className="mt-6 rounded-panel border border-hairline bg-panel p-4">
          <h3 className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">
            Designated agent
          </h3>
          {published ? (
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-ink-faint">Name</dt>
              <dd><ContactValue label="Agent name" value={dmcaAgent.name} /></dd>
              <dt className="text-ink-faint">Address</dt>
              <dd><ContactValue label="Agent address" value={dmcaAgent.address} /></dd>
              <dt className="text-ink-faint">Telephone</dt>
              <dd><ContactValue label="Agent telephone" value={dmcaAgent.phone} /></dd>
              <dt className="text-ink-faint">Email</dt>
              <dd><ContactValue label="Agent email" value={dmcaAgent.email} /></dd>
            </dl>
          ) : (
            <div className="mt-3 space-y-3">
              <p role="status" className="rounded-control border border-sev-high bg-raised p-3 text-sm leading-6 text-ink">
                <strong className="font-semibold">A designated agent has not been published yet.</strong>{' '}
                Until one is, this site makes no claim to the DMCA section 512(c) safe harbour.
                That does not stop you sending a notice, and it does not stop the material being
                removed — send it to the general contact below and it will be handled on the same
                terms as every other request on this page.
              </p>
              <p className="text-sm leading-6 text-ink-muted">
                General contact: <ContactEmail />
              </p>
              <p className="text-sm leading-6 text-ink-muted">
                For a routine request with no personal, credential, or security details, <PublicRequestLink />.
                Do not put personal data, credentials, or security details in email.
              </p>
            </div>
          )}
        </div>
      </LegalSection>

      <LegalSection id="counter-notice" heading="If your work was removed by mistake">
        <p>
          If material you posted upstream was removed because of a notice you believe was mistaken
          or misdirected, you can send a counter-notice. It must contain your signature, an
          identification of what was removed and where it appeared, a statement under penalty of
          perjury that you believe in good faith it was removed as a result of mistake or
          misidentification, your contact details, your consent to the jurisdiction of the federal
          district court in the district where your address is located (or, if you are outside the United States,
          any judicial district in which this service provider may be found), and your acceptance
          of service of process from the person who sent the original notification.
        </p>
        <p>
          If the counter-notice meets the statutory requirements, access may be restored between
          ten and fourteen business days after it is received, unless the original complainant
          tells us they have filed a court action.
        </p>
      </LegalSection>

      <LegalSection id="repeat-infringers" heading="Repeat infringers">
        <p>
          A source that is the subject of repeated substantiated complaints is removed from the
          source register, and every entry acquired from it is excluded from the catalogue on the
          next rebuild. This is a policy about <em>sources</em> rather than accounts, because the
          site has no accounts: nobody uploads anything here, and the only thing that can
          repeatedly carry infringing material is an upstream repository.
        </p>
      </LegalSection>
    </>
  );
}
