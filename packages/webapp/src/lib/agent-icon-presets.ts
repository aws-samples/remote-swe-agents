export const PRESET_ICON_PREFIX = 'preset:';

export type PresetIcon = {
  id: string;
  label: string;
  color: string;
  paths: string[];
};

export const presetIcons: PresetIcon[] = [
  {
    id: 'robot',
    label: 'Agent',
    color: '#2563eb',
    paths: ['M12 8V4H8', 'M4 8h16v12H4z', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
  },
  {
    id: 'runtime',
    label: 'Runtime',
    color: '#7c3aed',
    paths: [
      'M4 4h16v16H4z',
      'M9 9h6v6H9z',
      'M15 2v2',
      'M15 20v2',
      'M2 15h2',
      'M2 9h2',
      'M20 15h2',
      'M20 9h2',
      'M9 2v2',
      'M9 20v2',
    ],
  },
  {
    id: 'compute',
    label: 'Compute',
    color: '#f97316',
    paths: ['M2 2h20v8H2z', 'M2 14h20v8H2z', 'M6 6h.01', 'M6 18h.01'],
  },
  {
    id: 'database',
    label: 'Database',
    color: '#0284c7',
    paths: [
      'M3 5c0-1.7 4-3 9-3s9 1.3 9 3-4 3-9 3-9-1.3-9-3',
      'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5',
      'M3 12c0 1.7 4 3 9 3s9-1.3 9-3',
    ],
  },
  {
    id: 'cloud',
    label: 'Cloud',
    color: '#0d9488',
    paths: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'],
  },
  {
    id: 'terminal',
    label: 'CLI',
    color: '#374151',
    paths: ['m4 17 6-6-6-6', 'M12 19h8'],
  },
  {
    id: 'web',
    label: 'Web',
    color: '#059669',
    paths: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  },
  {
    id: 'docs',
    label: 'Docs',
    color: '#e11d48',
    paths: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  },
];

export const isPresetIconKey = (iconKey: string | undefined): boolean =>
  Boolean(iconKey && iconKey.startsWith(PRESET_ICON_PREFIX));

export const getPresetIcon = (iconKey: string): PresetIcon | undefined =>
  presetIcons.find((p) => `${PRESET_ICON_PREFIX}${p.id}` === iconKey);

export const presetIconSvg = (preset: PresetIcon, size: number): string => {
  const inner = preset.paths.map((d) => `<path d="${d}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="24" fill="${preset.color}"/>` +
    `<g transform="translate(12 12)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>` +
    `</svg>`
  );
};
