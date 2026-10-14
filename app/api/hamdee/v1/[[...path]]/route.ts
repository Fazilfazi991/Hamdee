import { handleOwnerPropertyRequest } from '../../../../../src/owner-runtime';
export const runtime='nodejs';
export const dynamic='force-dynamic';
// Explicit owner composition; missing approved configuration fails closed.
export const GET=handleOwnerPropertyRequest;
export const POST=handleOwnerPropertyRequest;
export const PATCH=handleOwnerPropertyRequest;
export const DELETE=handleOwnerPropertyRequest;
