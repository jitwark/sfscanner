import { ContactValue } from './legal-page';
import { contactEmail, isPending, publicRequestEmailUrl } from './legal-contacts';

export function ContactEmail() {
  if (isPending(contactEmail)) return <ContactValue label="Contact email" value={contactEmail} />;
  return (
    <a className="font-mono text-sm text-accent-text underline underline-offset-2" href={`mailto:${contactEmail}`}>
      {contactEmail}
    </a>
  );
}

export function PublicRequestLink() {
  return (
    <a
      className="text-accent-text underline underline-offset-2"
      href={publicRequestEmailUrl}
      aria-label="email a routine takedown request"
    >
      email a routine request
    </a>
  );
}
