import {
  cleanCrossSeedBaseUrl,
  detectCrossSeedInstanceIds,
  normalizeCrossSeedMarkers,
} from '../dist/crossSeed.js';

const instances = [
  { id: 'main', label: 'cross-seed principal', baseUrl: 'http://cross-seed:2468', clientId: 'qbit-main', markers: ['cross-seed-link', 'cross-seed'], enabled: true },
  { id: 'other', label: 'cross-seed secondaire', baseUrl: 'http://cross-seed-2:2468', clientId: 'qbit-other', markers: ['secondary-cross-seed'], enabled: true },
  { id: 'disabled', label: 'désactivé', baseUrl: 'http://disabled:2468', clientId: 'qbit-main', markers: ['cross-seed-link'], enabled: false },
];

const linked = detectCrossSeedInstanceIds(instances, 'qbit-main', 'cross-seed-link', []);
if (linked.join(',') !== 'main') throw new Error(`linkCategory detection failed: ${linked.join(',')}`);

const duplicated = detectCrossSeedInstanceIds(instances, 'qbit-main', 'Movies.cross-seed', []);
if (duplicated.join(',') !== 'main') throw new Error(`duplicate category detection failed: ${duplicated.join(',')}`);

const tagged = detectCrossSeedInstanceIds(instances, 'qbit-other', '', ['secondary-cross-seed']);
if (tagged.join(',') !== 'other') throw new Error(`tag detection failed: ${tagged.join(',')}`);

if (normalizeCrossSeedMarkers([]).join(',') !== 'cross-seed-link,cross-seed') {
  throw new Error('default cross-seed markers are missing');
}

if (cleanCrossSeedBaseUrl('http://cross-seed:2468/?apikey=secret#fragment') !== 'http://cross-seed:2468') {
  throw new Error('cross-seed base URL must discard secrets and fragments');
}

if (cleanCrossSeedBaseUrl('file:///config/cross-seed.db') !== '') {
  throw new Error('cross-seed base URL must only accept HTTP(S)');
}

console.log('cross-seed checks OK: client isolation, categories, tags and safe URLs.');
