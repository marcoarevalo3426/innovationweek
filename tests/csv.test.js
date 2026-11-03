import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../shared/csv.js';

test('CSV preserves Unicode, quoted commas, multiline values and empty cells',()=>{
  assert.equal(toCsv(['Title','Notes'],[['Café, "broadcast"','Line one\nLine two'],[null,2]]), '\uFEFF"Title","Notes"\r\n"Café, ""broadcast""","Line one\nLine two"\r\n"","2"\r\n');
});
test('CSV user text cannot become a spreadsheet formula, including after whitespace',()=>{
  const text=toCsv(['Value'],[['=1+1'],['  @SUM(A1)'],['-cmd'],['+cmd'],[12]]);
  for(const expected of ['"\'=1+1"','"\'  @SUM(A1)"','"\'-cmd"','"\'+cmd"','"12"']) assert.ok(text.includes(expected));
});
