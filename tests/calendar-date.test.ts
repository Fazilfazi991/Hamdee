import test from 'node:test';
import assert from 'node:assert/strict';
import {types} from 'pg';
import {calendarDateTypes,localConnectionOptions} from '../src/database';
import {day} from '../src/rental';
test('HAMDEE SQL DATE remains an exact calendar label without changing global pg timestamp parsers',()=>{
 const globalParser=types.getTypeParser(1082,'text'),parsers=calendarDateTypes();
 for(const date of ['2026-11-01','2026-11-03','2025-03-01','2024-02-29'])assert.equal(day((parsers.getTypeParser(1082,'text') as unknown as (input:string)=>string)(date)),date);
 assert.equal(types.getTypeParser(1082,'text'),globalParser);
 assert.equal((parsers.getTypeParser(1184,'text') as unknown as (input:string)=>Date)('2026-11-03 00:30:00+05:30').toISOString(),'2026-11-02T19:00:00.000Z');
 const options=localConnectionOptions('postgres://synthetic:synthetic@127.0.0.1:5433/hamdee_dev_dates');
 assert.equal((options.types.getTypeParser(1082,'text') as unknown as (input:string)=>string)('2026-11-03'),'2026-11-03');
});
