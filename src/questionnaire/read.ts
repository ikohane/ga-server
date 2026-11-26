// A questionnaire response file: answers a person (the patient, a parent, a carer) gave to a set of questions, as a FHIR R4
// QuestionnaireResponse, or a Bundle of them. This is GA's class for anything asked and answered outside a hospital record:
// a parent's history questionnaire, a symptom diary form, a pre-visit form. docs/questionnaires.md.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { Patient, Questionnaire, QuestionnaireResponse, QuestionnaireResponseItem, QuestionnaireResponseItemAnswer, Resource } from '@medplum/fhirtypes';
import { GaError } from '../config.ts';

export const QUESTIONNAIRE_ID = 'urn:ga-server:id:questionnaire';
const MAX_BYTES = 20 * 1024 * 1024;
const STATUS = new Set(['in-progress', 'completed', 'amended', 'stopped']);
// An answer that says the person was asked and gave no value (FHIR data-absent-reason).
export const ABSENT = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';

// True for a .json file whose top-level resourceType is QuestionnaireResponse or Bundle (an Epic FHIR export file has neither).
export function isQuestionnaireFile(path: string): boolean {
  if (!/\.json$/i.test(path)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4096);
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    return /^\s*\{\s*"resourceType"\s*:\s*"(QuestionnaireResponse|Bundle)"/.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type QuestionnaireFile = {
  responses: QuestionnaireResponse[]; // as GA stores them: its own identifier, no patient inside
  subjects: { birthDate?: string }[]; // what the file says about who each response is about (same order)
  date: string; // newest `authored`
};

// The form's name, kept on the stored response (the form itself is not stored). A file gives it as GA's extension, as the
// title of a contained Questionnaire, or as the FHIR display extension on `questionnaire`.
export const TITLE = 'urn:ga-server:ext:questionnaire-title';
const DISPLAY = 'http://hl7.org/fhir/StructureDefinition/display';
type Ext = { url?: string; valueString?: string };
const title = (r: QuestionnaireResponse): string | undefined =>
  ((r.extension ?? []) as Ext[]).find((e) => e.url === TITLE)?.valueString
  ?? (r.contained as Resource[] | undefined)?.find((c): c is Questionnaire => c.resourceType === 'Questionnaire')?.title
  ?? ((r as { _questionnaire?: { extension?: Ext[] } })._questionnaire?.extension ?? []).find((e) => e.url === DISPLAY)?.valueString;
export const questionnaireTitle = (r: QuestionnaireResponse): string => title(r) ?? 'Questionnaire';

function checkItems(items: QuestionnaireResponseItem[] | undefined, where: string): number {
  let answered = 0;
  for (const [n, it] of (items ?? []).entries()) {
    const at = `${where}item[${n}]`;
    if (!it || typeof it.linkId !== 'string' || !it.linkId) throw new GaError(`${at} has no linkId`);
    const answers = it.answer ?? [];
    // The record must read without the form that asked: an answered item carries its question.
    if (answers.length && (typeof it.text !== 'string' || !it.text.trim())) throw new GaError(`${at} has an answer but no question text`);
    answered += answers.length ? 1 : 0;
    for (const a of answers) answered += checkItems(a.item, `${at}.answer.`);
    answered += checkItems(it.item, `${at}.`);
  }
  return answered;
}

// Reads and checks the file. Messages name the place of a fault, never a value.
export function readQuestionnaireFile(path: string): QuestionnaireFile {
  if (statSync(path).size > MAX_BYTES) throw new GaError('questionnaire file is larger than 20 MB');
  let doc: Resource & { entry?: { resource?: Resource }[] };
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GaError('questionnaire file is not valid JSON');
  }
  const inFile: Resource[] = doc.resourceType === 'Bundle' ? (doc.entry ?? []).map((e) => e.resource).filter((r): r is Resource => !!r) : [doc];
  const other = inFile.find((r) => r.resourceType !== 'QuestionnaireResponse' && r.resourceType !== 'Patient');
  if (other) throw new GaError(`not a questionnaire file: it holds a ${other.resourceType}; expected QuestionnaireResponse (or a Bundle of them)`);
  const raw = inFile.filter((r): r is QuestionnaireResponse => r.resourceType === 'QuestionnaireResponse');
  if (!raw.length) throw new GaError('not a questionnaire file: no QuestionnaireResponse in it');
  const patients = new Map<string, Patient>();
  for (const r of inFile) if (r.resourceType === 'Patient' && r.id) patients.set(`Patient/${r.id}`, r);

  const seen = new Set<string>();
  const responses: QuestionnaireResponse[] = [];
  const subjects: { birthDate?: string }[] = [];
  for (const [n, r] of raw.entries()) {
    const at = raw.length > 1 ? `response ${n + 1}: ` : '';
    const id = [r.identifier ?? []].flat()[0];
    if (!id?.system || !id.value) throw new GaError(`${at}identifier (system and value) is required: it is how a later copy of these answers replaces this one`);
    const value = `${id.system}|${id.value}`;
    if (seen.has(value)) throw new GaError(`${at}the same identifier appears twice in the file`);
    seen.add(value);
    if (!STATUS.has(r.status)) throw new GaError(`${at}status must be one of ${[...STATUS].join(', ')}`);
    if (typeof r.authored !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(r.authored) || Number.isNaN(Date.parse(r.authored))) throw new GaError(`${at}authored (date and time of the latest answer) is required`);
    if (Date.parse(r.authored) > Date.now() + 86_400_000) throw new GaError(`${at}authored is in the future`);
    if (!checkItems(r.item, at)) throw new GaError(`${at}no answered question`);
    const contained = (r.contained ?? []) as Resource[];
    const ref = r.subject?.reference ?? '';
    const about = ref.startsWith('#') ? contained.find((c): c is Patient => c.resourceType === 'Patient' && c.id === ref.slice(1)) : patients.get(ref);
    subjects.push({ birthDate: about?.birthDate });
    // Who answered and who wrote it down stay as words: the file's people are not GA records.
    const words = (x?: { display?: string }) => (x?.display ? { display: x.display } : undefined);
    const { id: _id, meta: _meta, subject: _subject, contained: _contained, source, author, encounter: _encounter, basedOn: _basedOn, partOf: _partOf, questionnaire, extension, ...rest } = r;
    const named = title(r);
    const ext = [...((extension ?? []) as Ext[]).filter((e) => e.url !== TITLE), ...(named ? [{ url: TITLE, valueString: named }] : [])];
    delete (rest as { _questionnaire?: unknown })._questionnaire;
    responses.push({
      ...rest,
      id: `qr-${n}`,
      identifier: { system: QUESTIONNAIRE_ID, value },
      ...(questionnaire && !questionnaire.startsWith('#') && { questionnaire }),
      ...(ext.length && { extension: ext }),
      ...(words(source) && { source: words(source) }),
      ...(words(author) && { author: words(author) }),
    } as QuestionnaireResponse);
  }
  return { responses, subjects, date: responses.map((r) => r.authored!).sort().at(-1)! };
}

const answerValue = (a: QuestionnaireResponseItemAnswer): string | undefined => {
  const x = a as Record<string, unknown>;
  if (a.valueCoding) return a.valueCoding.display ?? a.valueCoding.code;
  if (a.valueQuantity) return [a.valueQuantity.value, a.valueQuantity.unit].filter((v) => v !== undefined).join(' ');
  if (typeof a.valueBoolean === 'boolean') return a.valueBoolean ? 'Yes' : 'No';
  if (a.valueReference) return a.valueReference.display;
  if (a.valueAttachment) return a.valueAttachment.title;
  const k = Object.keys(x).find((key) => key.startsWith('value'));
  return k === undefined || x[k] === undefined || x[k] === null ? undefined : String(x[k]);
};

export type AnswerRow = { depth: number; linkId: string; question?: string; answers: string[]; absent: boolean; heading: boolean };
// The response flattened in order: headings (groups), questions with their answers, follow-ups one level in.
export function answerRows(r: QuestionnaireResponse): AnswerRow[] {
  const out: AnswerRow[] = [];
  const walk = (items: QuestionnaireResponseItem[] | undefined, depth: number): void => {
    for (const it of items ?? []) {
      const answers = (it.answer ?? []).map(answerValue).filter((v): v is string => !!v);
      const heading = !it.answer?.length && !!it.item?.length;
      out.push({ depth, linkId: it.linkId, question: it.text, answers, absent: !!it.answer?.length && it.answer.every((a) => a.valueCoding?.system === ABSENT), heading });
      for (const a of it.answer ?? []) walk(a.item, depth + 1);
      walk(it.item, depth + 1);
    }
  };
  walk(r.item, 0);
  return out;
}

// The whole response as text, for notes_search.
export function questionnaireText(r: QuestionnaireResponse): string | undefined {
  const lines = answerRows(r).filter((x) => x.heading || x.answers.length).map((x) => (x.heading ? x.question ?? '' : `${x.question ?? x.linkId} ${x.answers.join('; ')}`));
  return lines.length ? lines.join('\n') : undefined;
}
