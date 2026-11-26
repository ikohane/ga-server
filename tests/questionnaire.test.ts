import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { QuestionnaireResponse, Resource } from '@medplum/fhirtypes';
import { onStore } from './temp-store.ts';

vi.mock('../src/lock.ts', () => ({ withImportLock: async (fn: () => Promise<unknown>) => fn() }));
const { importQuestionnaire } = await import('../src/questionnaire/import.ts');
const { answerRows, isQuestionnaireFile, questionnaireText, readQuestionnaireFile, ABSENT } = await import('../src/questionnaire/read.ts');
const { detectKind } = await import('../src/import.ts');
const { notesSearch } = await import('../src/notes.ts');
const { makeDetails } = await import('../src/ui/detail.ts');

// A made-up response: nothing here is about a real person.
const response = (extra: object = {}): QuestionnaireResponse => ({
  resourceType: 'QuestionnaireResponse',
  identifier: { system: 'urn:example:forms', value: 'garden-1' },
  status: 'in-progress',
  authored: '2025-03-01T10:00:00Z',
  contained: [{ resourceType: 'Questionnaire', id: 'q', status: 'active', title: 'Garden questions' }, { resourceType: 'Patient', id: 'who', birthDate: '2001-02-03' }],
  questionnaire: '#q',
  subject: { reference: '#who' },
  source: { reference: 'RelatedPerson/x', display: 'Parent' },
  item: [{ linkId: 'r1', text: 'The garden', item: [
    { linkId: '1.01', text: 'Does the child like tomatoes?', answer: [{ valueString: 'Only cooked', item: [{ linkId: '1.01.then0', text: 'Which kind?', answer: [{ valueString: 'Plum' }] }] }] },
    { linkId: '1.02', text: 'When was the tree planted?', answer: [{ valueCoding: { system: ABSENT, code: 'asked-unknown', display: "I don't know" } }] },
    { linkId: '1.03', text: 'What grows best?' },
  ] }],
  ...extra,
}) as QuestionnaireResponse;
const fileOf = (doc: object, name = 'answers.json'): string => { const f = join(mkdtempSync(join(tmpdir(), 'ga-q-')), name); writeFileSync(f, JSON.stringify(doc, null, 1)); return f; };

test('a questionnaire file is told apart from a FHIR export by its first lines', () => {
  expect(isQuestionnaireFile(fileOf(response()))).toBe(true);
  expect(detectKind(fileOf(response()))).toBe('questionnaire');
  expect(detectKind(fileOf({ fhir: {} }))).toBe('fhir-export');
  expect(isQuestionnaireFile(join(tmpdir(), 'no-such-file.json'))).toBe(false);
});

test('reading: GA identifier, no patient inside, people kept as words; faults named without values', () => {
  const r = readQuestionnaireFile(fileOf(response()));
  expect(r.subjects).toEqual([{ birthDate: '2001-02-03' }]);
  expect(r.responses[0].identifier).toEqual({ system: 'urn:ga-server:id:questionnaire', value: 'urn:example:forms|garden-1' });
  expect(r.responses[0].contained).toBeUndefined();
  expect(r.responses[0].questionnaire).toBeUndefined();
  expect(r.responses[0].extension).toEqual([{ url: 'urn:ga-server:ext:questionnaire-title', valueString: 'Garden questions' }]);
  expect(r.responses[0].source).toEqual({ display: 'Parent' });
  expect(r.responses[0].subject).toBeUndefined();
  expect(() => readQuestionnaireFile(fileOf(response({ identifier: undefined })))).toThrow('identifier (system and value) is required');
  expect(() => readQuestionnaireFile(fileOf(response({ authored: '2025-03-01' })))).toThrow('authored (date and time of the latest answer) is required');
  expect(() => readQuestionnaireFile(fileOf(response({ status: 'entered-in-error' })))).toThrow('status must be one of');
  expect(() => readQuestionnaireFile(fileOf(response({ item: [{ linkId: 'a', answer: [{ valueString: 'x' }] }] })))).toThrow('item[0] has an answer but no question text');
  expect(() => readQuestionnaireFile(fileOf(response({ item: [{ linkId: 'a', text: 'Asked' }] })))).toThrow('no answered question');
  expect(() => readQuestionnaireFile(fileOf({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation' } }] }))).toThrow('it holds a Observation');
});

test('rows and text: headings, answers, follow-ups, "don\'t know" marked', () => {
  const rows = answerRows(response());
  expect(rows.map((x) => [x.depth, x.linkId, x.answers.join('|'), x.absent, x.heading])).toEqual([
    [0, 'r1', '', false, true], [1, '1.01', 'Only cooked', false, false], [2, '1.01.then0', 'Plum', false, false], [1, '1.02', "I don't know", true, false], [1, '1.03', '', false, false],
  ]);
  expect(questionnaireText(response())).toBe("The garden\nDoes the child like tomatoes? Only cooked\nWhich kind? Plum\nWhen was the tree planted? I don't know");
});

test('import: one record per response; the same file again changes nothing; newer answers replace; another person is refused', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient', birthDate: '2001-02-03' })).id as string;
    const cfg = { patientId: pid } as never;
    const first = fileOf(response());
    expect(await importQuestionnaire(client, cfg, first, pid)).toMatchObject({ created: 1, responses: 1, subjectChecked: true, invalid: 0 });
    expect(await importQuestionnaire(client, cfg, first, pid)).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    const later = response({ status: 'completed', authored: '2025-03-05T09:00:00Z' });
    later.item![0].item![2].answer = [{ valueString: 'Beans' }];
    expect(await importQuestionnaire(client, cfg, fileOf(later), pid)).toMatchObject({ created: 0, updated: 1 });
    expect(await importQuestionnaire(client, cfg, first, pid)).toMatchObject({ created: 0, updated: 0, skipped: 1 }); // an older copy never wins

    const stored = await client.searchResources('QuestionnaireResponse', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'completed', subject: { reference: `Patient/${pid}` }, identifier: { system: 'urn:ga-server:id:questionnaire', value: 'urn:example:forms|garden-1' } });
    expect(stored[0].meta?.tag?.map((t) => t.code)).toEqual(expect.arrayContaining(['src-questionnaire', 'writer-importer']));
    expect(JSON.stringify(stored[0])).toContain('Beans');
    // the source files are kept, as stored files
    expect(await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: 'urn:ga-server:id:file|' }, { cache: 'no-cache' })).toHaveLength(2);

    const found = await notesSearch(client, pid, { text: 'beans' });
    expect(found.rows).toEqual([{ date: '2025-03-05', kind: 'questionnaire: Garden questions', author: 'Parent', snippet: expect.stringContaining('What grows best? Beans'), type: 'QuestionnaireResponse', id: stored[0].id }]);

    const d = makeDetails(stored as Resource[])({ ref: `QuestionnaireResponse/${stored[0].id}` } as never)!;
    expect(d.title).toBe('Garden questions');
    expect(d.facts).toEqual(expect.arrayContaining([['Answered by', 'Parent'], ['Questions', '2 answered, 1 "don\'t know" or declined, 0 left blank']]));
    expect(d.sections.find((s) => s.title === 'The garden')).toMatchObject({ type: 'table', head: ['Question', 'Answer'], rows: [['Does the child like tomatoes?', 'Only cooked'], ['↳ Which kind?', 'Plum'], ['When was the tree planted?', "I don't know"], ['What grows best?', 'Beans']] });

    const other = (await client.createResource({ resourceType: 'Patient', birthDate: '1999-09-09' })).id as string;
    await expect(importQuestionnaire(client as MedplumClient, { patientId: other } as never, first, other)).rejects.toThrow('different birth date');
    expect(await client.searchResources('QuestionnaireResponse', { subject: `Patient/${other}` }, { cache: 'no-cache' })).toHaveLength(0);
    expect(await client.searchResources('DocumentReference', { subject: `Patient/${other}` }, { cache: 'no-cache' })).toHaveLength(0);
  });
});
