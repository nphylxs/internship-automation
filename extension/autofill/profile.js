// Only these explicitly saved values can be copied into an employer's form.
export const profileFields = {
  firstName: 'First name', lastName: 'Last name', preferredName: 'Preferred name',
  email: 'Email', phone: 'Phone', addressLine1: 'Street address', addressLine2: 'Apartment / unit',
  city: 'City', state: 'State / province', postalCode: 'Postal code', country: 'Country',
  university: 'University', degree: 'Degree', major: 'Major / field of study',
  graduationYear: 'Graduation year', linkedin: 'LinkedIn URL', github: 'GitHub URL', website: 'Portfolio / website URL'
};
export function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter a JSON object for your autofill profile.');
  const profile = {};
  for (const [key, input] of Object.entries(value)) {
    if (!Object.hasOwn(profileFields,key)) throw new Error(`Unknown profile field: ${key}`);
    if (typeof input !== 'string' || input.length > 500) throw new Error(`${profileFields[key]} must be text, up to 500 characters.`);
    profile[key] = input.trim();
  }
  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new Error('Enter a valid email address.');
  for (const field of ['linkedin', 'github', 'website']) {
    if (!profile[field]) continue;
    let url; try { url = new URL(profile[field]); } catch { throw new Error(`${profileFields[field]} needs a full https:// URL.`); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`${profileFields[field]} must use HTTP or HTTPS.`);
  }
  if (profile.graduationYear && !/^20\d{2}$/.test(profile.graduationYear)) throw new Error('Graduation year must have four digits.');
  return profile;
}

export function supportedATS(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host.endsWith('.myworkdayjobs.com') || host.endsWith('.myworkdaysite.com')) return 'Workday';
    if (['boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(host)) return 'Greenhouse';
    if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(host)) return 'Lever';
  } catch { /* An unrelated or invalid URL is not an application page. */ }
  return null;
}

const clean = text => String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_\W]+/g, ' ').trim();
const sensitive = /\b(password|username|captcha|social security|ssn|national id|passport|bank|credit card|signature|consent|certify|agree|gender|sex|race|ethnicity|disability|veteran|citizenship|sponsorship|authorized|authorisation|authorization)\b/;
const otherPerson = /\b(reference|referee|referral|referrer|supervisor|manager|recruiter|emergency|parent|guardian|mother|father|spouse|previous employer)\b/;
const autocomplete = {'given-name':'firstName', 'family-name':'lastName', name:'fullName', nickname:'preferredName', email:'email', tel:'phone', 'address-line1':'addressLine1', 'address-line2':'addressLine2', 'address-level2':'city', 'address-level1':'state', 'postal-code':'postalCode', 'country-name':'country'};
const patterns = [
  ['firstName', /^(?:(?:legal|your) )?(?:first|given) names?$/],
  ['lastName', /^(?:(?:legal|your) )?(?:(?:last|family) names?|surname)$/],
  ['preferredName', /^(?:preferred|chosen) (?:first )?name$/],
  ['fullName', /^(?:(?:your|legal) )?(?:full name|name)$/],
  ['email', /^(?:(?:your|contact|personal|primary) )?e ?mail(?: address)?$/],
  ['phone', /^(?:(?:your|contact|primary|mobile|cell|home) )?(?:phone|telephone|mobile)(?: number)?$/],
  ['linkedin', /^(?:your )?linked ?in(?: profile)?(?: url| link)?$/],
  ['github', /^(?:your )?git ?hub(?: profile)?(?: url| link)?$/],
  ['website', /^(?:your |personal )?(?:website|portfolio)(?: url| link)?$/],
  ['addressLine1', /^(?:street address|address line 1|address 1)$/],
  ['addressLine2', /^(?:address line 2|address 2|apartment|apartment unit|unit)$/],
  ['city', /^(?:(?:your|current) )?(?:city|town|city town)$/],
  ['state', /^(?:state|province|state province|region)$/],
  ['postalCode', /^(?:zip|postal|zip postal)(?: code)?$/],
  ['country', /^(?:country|country region|country of residence)$/],
  ['university', /^(?:(?:current|your) )?(?:school|university|college|institution)(?: name| university| college)?$/],
  ['degree', /^(?:degree|degree type|degree level|highest degree)$/],
  ['major', /^(?:major|field of study|discipline|academic discipline)$/],
  ['graduationYear', /^(?:(?:expected|anticipated) )?graduation year$/]
];
export function matchField({label = '', hints = [], autocomplete: hint = '', context = ''}) {
  const all = clean([label, ...hints, context].join(' '));
  if (sensitive.test(all) || otherPerson.test(all)) return null;
  // Labels outrank generated identifiers; ambiguous labels never guess from IDs.
  const candidates = (label.trim() ? [label] : hints).map(clean).map(v => v.replace(/\b(required|optional)\b/g, '').trim());
  for (const text of candidates) {
    const found = patterns.find(([, pattern]) => pattern.test(text));
    if (found) return found[0];
  }
  const token = hint.split(/\s+/).at(-1);
  return autocomplete[token] || null;
}
export function valueFor(field, profile) {
  if (field === 'fullName') return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  return profile[field] || '';
}
export function matchingOption(options, value) {
  const normalize = text => clean(text).replace(/^united states of america$/, 'united states').replace(/^usa?$/, 'united states');
  const matches = options.filter(o => !o.disabled && o.value && (normalize(o.text) === normalize(value) || normalize(o.value) === normalize(value)));
  return matches.length === 1 ? matches[0].value : null;
}
