import { db, guard, type Env } from '../_lib/util.ts';
import { handleAggregate } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env }) => guard(() => handleAggregate(db(env)));
