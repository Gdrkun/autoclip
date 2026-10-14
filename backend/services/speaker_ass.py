"""Render speaker colors and two overlapping caption rows on scene timelines."""
def _time(milliseconds):
    value = max(0, round(milliseconds / 10))
    return f'{value // 360000}:{value // 6000 % 60:02}:{value // 100 % 60:02}.{value % 100:02}'


def _text(value):
    return value.replace('\\', '＼').replace('{', '｛').replace('}', '｝').replace('\r', '').replace('\n', '\\N')


def _header(width, height, style):
    size = max(14, round(height * (.05 if style == 'bold' else .042)))
    border = 3 if style == 'box' else 1
    return ('[Script Info]\nScriptType: v4.00+\n'
            f'PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n'
            '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            f'Style: Default,Microsoft YaHei,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,{border},2,0,2,24,24,24,1\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')


def _events(document, start_ms, end_ms, width, height, offset_ms=0, style='clean'):
    colors = {s.speaker_id: s.color for s in document.speakers}
    active, lines = [], []
    size = max(14, round(height * (.05 if style == 'bold' else .042)))
    for cue in sorted(document.subtitles, key=lambda item: (item.start_ms, item.layer, item.id)):
        start, end = max(start_ms, cue.start_ms), min(end_ms, cue.end_ms)
        if end <= start:
            continue
        active = [(e, slot) for e, slot in active if e > start]
        occupied = {slot for _, slot in active}
        slot = cue.layer
        if slot in occupied:
            slot = 1 - slot
        if slot in occupied:
            raise ValueError('同一时间最多支持两行字幕，请合并或调整字幕时间')
        active.append((end, slot))
        color = colors.get(cue.speaker_id, '#FFFFFF').lstrip('#')
        bgr = color[4:6] + color[2:4] + color[:2]
        y = height - max(18, round(height * .09)) - slot * round(size * 1.6)
        prefix = '{' + f'\\an2\\pos({width // 2},{y})\\1c&H{bgr}&' + '}'
        left, right = start - start_ms + offset_ms, end - start_ms + offset_ms
        if _time(right) == _time(left):
            continue
        lines.append(f'Dialogue: {slot},{_time(left)},{_time(right)},Default,,0,0,0,,{prefix}{_text(cue.text)}')
    return lines


def scene_ass(document, scene, width, height, style='clean'):
    return _header(width, height, style) + '\n'.join(_events(document, round(scene.start * 1000), round(scene.end * 1000), width, height, style=style)) + '\n'


def draft_ass(document, scenes, width=1920, height=1080, style='clean'):
    from backend.services.studio.audio import scene_duration
    lines, offset = [], 0
    for scene in scenes:
        lines.extend(_events(document, round(scene.start * 1000), round(scene.end * 1000), width, height, offset, style))
        offset += round(scene_duration(scene) * 1000)
    return _header(width, height, style) + '\n'.join(lines) + '\n'
