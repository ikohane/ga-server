import { resolve } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { GaError, type GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { withImportLock } from '../lock.ts';
import { readQuestionnaireFile } from './read.ts';

const PATIENT: Resource = { resourceType: 'Patient', id: 'questionnaire-patient' };

export type QuestionnaireReport = ImportReport & { responses: number; subjectChecked: boolean };

// ga import <response.json>: each QuestionnaireResponse becomes one record of GA's person, identified by the response's own
// identifier, so a later file with more answers (a newer `authored`) replaces it and the same file again changes nothing.
// A file that says whom it is about (a Patient with a birth date) is refused when that is not this GA's person.
export async function importQuestionnaire(client: MedplumClient, cfg: GaConfig, path: string, patientId: string): Promise<QuestionnaireReport> {
  void cfg;
  const read = readQuestionnaireFile(path); // throws before any write
  const stated = read.subjects.map((s) => s.birthDate).filter((d): d is string => !!d);
  if (stated.length) {
    const own = (await client.readResource('Patient', patientId, { cache: 'no-cache' })).birthDate;
    if (!own) throw new GaError('this GA has no birth date for its person, so it cannot check whom the answers are about; set it (an import of their record does) and try again');
    if (stated.some((d) => d !== own)) throw new GaError('these answers are about someone with a different birth date than this GA\'s person: nothing imported. Import them into that person\'s GA.');
  }
  const resources = read.responses.map((r) => ({ ...r, subject: { reference: `Patient/${PATIENT.id}` } }) as Resource);
  const report = await withImportLock(async () => {
    const { fileHash } = await storeDocument(client, path, patientId, 'application/json');
    return importResources(client, [PATIENT, ...resources], { kind: 'questionnaire', file: resolve(path), date: read.date, writer: 'importer', dateOf: (r) => (r as { authored?: string }).authored ?? '' }, patientId, fileHash);
  });
  return { ...report, responses: read.responses.length, subjectChecked: stated.length === read.responses.length };
}
