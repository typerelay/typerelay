import test from 'node:test';
import assert from 'node:assert/strict';
import { Abbreviation } from '../public/abbreviation.js';

test('semicolon and legacy comma prefixes normalize to bare abbreviations', () => { assert.equal(Abbreviation.normalize(';est'),'est');assert.equal(Abbreviation.normalize(',est'),'est');assert.equal(Abbreviation.normalize('est'),'est'); });
