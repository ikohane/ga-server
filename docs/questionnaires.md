# Questionnaire responses

What a person answered when asked: the patient, a parent, a carer. A history questionnaire sent to a parent, a pre-visit form, a symptom diary form. GA keeps each as a FHIR R4 `QuestionnaireResponse`, apart from what clinicians recorded: an answer is what the person said on the day they said it, never a finding, a diagnosis or a correction of the hospital record.

## The file

`ga import <file.json>` (CLI only). The file is one `QuestionnaireResponse`, or a `Bundle` of them. GA tells it from an Epic FHIR export file by its first line (`"resourceType": "QuestionnaireResponse"` or `"Bundle"`).

| Field | Required | What GA does with it |
|---|---|---|
| `identifier` (`system`, `value`) | yes | Names this set of answers. A later file with the same identifier and a newer `authored` replaces the record; the same or an older file changes nothing. |
| `status` | yes | `in-progress` (more answers may come), `completed`, `amended` or `stopped`. |
| `authored` | yes | Date and time of the latest answer. Not in the future. It is the record's source date. |
| `item` | yes | Groups and questions. Every item has a `linkId`; every answered item carries its question in `text`, so the record reads without the form. At least one answer. |
| `subject` | no | A reference to a `Patient` inside the file (contained, or in the Bundle) with a `birthDate`. When given, GA refuses the file unless that birth date is its own person's. GA then sets `subject` to its person. |
| `source`, `author` | no | Who answered, and who wrote it down. Kept as words (`display`): "Mother", "Self". |
| the form's name | no | The `title` of a contained `Questionnaire` that `questionnaire` points to (`"#form"`), or the FHIR display extension on `questionnaire`. Stored as extension `urn:ga-server:ext:questionnaire-title`. The form itself is not stored. |

Answers: `valueString`, `valueBoolean`, `valueInteger`, `valueDecimal`, `valueDate`, `valueDateTime`, `valueQuantity`, `valueCoding`. "I don't know", "I can't remember" and "Prefer not to say" are a `valueCoding` from `http://terminology.hl7.org/CodeSystem/data-absent-reason` (`asked-unknown`, `asked-declined`) with the person's words as `display`. A question seen and left blank is an item without `answer`. A follow-up sits in the `item` of the answer that brought it up.

## Identity and tags

- Identifier: system `urn:ga-server:id:questionnaire`, value `<the file's identifier system>|<its value>`. (`QuestionnaireResponse.identifier` holds one identifier, so GA's replaces the file's; the stored source file keeps the original.)
- Tags: `src-questionnaire`, `writer-importer`. Not a clinic record (`isClinic` is false).
- Source date (`urn:ga-server:ext:source-date`): `authored`.
- The source file is stored once per content (a `DocumentReference` identified `urn:ga-server:id:file|<sha256>`), like every imported file. It is never shared; the response itself is shared with the patient's record like any other record.
- An Epic EHI export's answer sets are also `QuestionnaireResponse` (identifier `urn:ga-server:id:ehi:<org>`, tag `src-ehi`). They carry no question text and are left out of `notes_search`.

## One person, one GA

One GA install holds one person. A questionnaire about two children gives two files, one per child, each with only that child's answers (a question about the family goes into both). Import each into that child's GA. The birth date check stops a file from landing in the wrong one: nothing is written, not even the source file.

## Reading

- `notes_search` finds text in questions and answers: one row per response, kind `questionnaire: <form name>`, author = who answered. `fhir_read` opens it.
- `whats_new` counts new responses. `fhir_search` `QuestionnaireResponse` lists them.
- The chronology page lists them in "All records" under "Questionnaires". A click shows who answered, when, how many questions were answered, left blank or met with "don't know", then each question with its answer in the order asked.
- When an answer differs from the hospital record, say both and which is which. GA never changes the hospital record from an answer.

## Backup and restore

A response is a record in GA's database and its source file is in GA's file store, so the nightly backup (`ga-postgres.dump`, `ga-binary.tgz`) holds both and a restore brings both back ([operations.md](operations.md)). Take a backup before a first import into a record (`docker compose run --rm -e RUN_ONCE=1 ga-backup`): GA has no delete, so an import made in error is undone by restoring.

The tool that asked the questions should keep its own copy too: the decrypted answer events, each version of the questions that was sent, and each version of each response file.
