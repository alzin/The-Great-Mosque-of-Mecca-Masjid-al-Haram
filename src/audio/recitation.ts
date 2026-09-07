/** Recording provider: https://www.mp3quran.net/ar/sds */
export const RECITATION = {
  reciter: 'Abdul Rahman Al-Sudais',
  reciterArabic: 'عبد الرحمن السديس',
  sourcePage: 'https://www.mp3quran.net/ar/sds',
  server: 'https://server11.mp3quran.net/sds/',
  surahCount: 114,
} as const;

export function recitationUrl(surah: number): string {
  return `${RECITATION.server}${String(surah).padStart(3, '0')}.mp3`;
}
