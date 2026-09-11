import readXlsxFile, { readSheetNames } from 'read-excel-file/node';
import type { EncodedText, FileCodecI } from '../interfaces.ts';
import type { Attachment } from '../../core/interfaces.ts';
import { removeBase64Prefix } from './utils.ts';

/**
 * Encodes an Excel workbook into a JSON representation.
 *
 * Reads every sheet, not just the first one — emits an array of
 * `{ name, rows }` objects so multi-sheet workbooks survive the round-trip.
 */
export class ExcelCodec implements FileCodecI {
  async encode(file: Attachment): Promise<EncodedText[]> {
    const buffer = Buffer.from(removeBase64Prefix(file.data), 'base64');
    const sheetNames = await readSheetNames(buffer);
    const sheets = await Promise.all(
      sheetNames.map(async (name) => ({
        name,
        rows: await readXlsxFile(buffer, { sheet: name }),
      })),
    );
    return [
      {
        contentType: 'json',
        data: JSON.stringify(sheets),
      },
    ];
  }
}
