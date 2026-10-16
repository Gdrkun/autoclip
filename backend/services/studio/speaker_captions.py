"""Reuse recognized captions while keeping automatic suppression distinct from user OFF."""
import math

UNLOCATED_WARNING = '原视频自带字幕，但未确定字幕区域，可能与说话人字幕重叠。'


def has_captions(value):
    document = value.get('speaker_subtitles') or {}
    return isinstance(document, dict) and bool(document.get('subtitles'))


def attach_document(project_id, value):
    if value.get('speaker_subtitles') or not value.get('speaker_colors', True):
        return value
    from backend.services.speaker_integration import load_document
    document = load_document(project_id)
    return {**value, 'speaker_subtitles': document.model_dump()} if document else value


def caption_band(generation):
    band = generation.get('burned_caption_band')
    if not isinstance(band, (list, tuple)) or len(band) != 2:
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in band):
        return None
    return list(band) if 0 <= band[0] < band[1] <= 1 else None


def reconcile(value, generation, *, recover_legacy=False):
    if not has_captions(value):
        return value
    result = dict(value)
    legacy = (recover_legacy and value.get('revision', 1) == 1
              and str(value.get('origin') or '').startswith('auto-')
              and not value.get('parent_draft_id')
              and value.get('speaker_colors', True)
              and generation.get('source_has_burned_subtitles'))
    if not result.get('subtitles', True) and (result.get('subtitles_auto_suppressed') or legacy):
        result['subtitles'] = True
        result.pop('subtitles_auto_suppressed', None)
    if result.get('subtitles', True) and generation.get('source_has_burned_subtitles'):
        band = caption_band(generation)
        if band:
            result['caption_mask'] = band
    return result
