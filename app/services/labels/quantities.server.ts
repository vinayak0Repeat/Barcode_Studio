/**
 * Server-side re-export of the quantity/sheet math. The implementation lives
 * in quantities.shared.ts because client components (Print Labels page,
 * print page) also need the constants/types, and React Router forbids client
 * bundles from importing ".server" modules.
 */
export * from "./quantities.shared";
