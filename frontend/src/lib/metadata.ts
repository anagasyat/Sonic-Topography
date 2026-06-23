import * as mm from 'music-metadata-browser';

export interface AudioMetadata {
  displayName: string;
  lyrics: string | null;
}

function getFallbackDisplayName(fallbackName: string): string {
  const decodedName = decodeURIComponent(fallbackName);
  return decodedName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Demo Track';
}

export async function extractAudioMetadata(blob: Blob, fallbackName: string): Promise<AudioMetadata> {
  const fallbackDisplayName = getFallbackDisplayName(fallbackName);

  try {
    const metadata = await mm.parseBlob(blob);
    const title = metadata.common.title?.trim();
    const artist = metadata.common.artist?.trim();
    const displayName = title ? (artist ? `${artist} - ${title}` : title) : fallbackDisplayName;
    const lyrics = metadata.common.lyrics?.find(Boolean) || null;

    return { displayName, lyrics };
  } catch (error) {
    console.warn('Error reading tags with music-metadata-browser:', error);
  }

  return { displayName: fallbackDisplayName, lyrics: null };
}

export async function extractLyricsFromAudio(file: File): Promise<string | null> {
  const metadata = await extractAudioMetadata(file, file.name);
  return metadata.lyrics;
}
