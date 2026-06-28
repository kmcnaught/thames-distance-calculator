// Re-export the canonical browser-side geo module so Node build scripts share
// exactly the same implementation. Single source of truth lives in
// lib/geo.mjs (it must be browser-importable).
export * from '../../lib/geo.mjs';
