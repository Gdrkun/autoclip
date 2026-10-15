"""Render speaker colors and two overlapping caption rows on scene timelines."""
def _time(milliseconds):
    value = max(0, round(milliseconds / 10))
    return f'{value // 360000}:{value // 6000 % 60:02}:{value // 100 % 60:02}.{value % 100:02}'


def _text(value):
    return value.replace('\\', '＼').replace('{', '｛').replace('}', '｝').replace('\r', '').replace('\n', '\\N')


def _geometry(width, height, style, layout=None):
    base = max(14, round(height * (.05 if style == 'bold' else .042)))
    size = round(base * (layout.font_scale if layout else 1))
    x = round(width * layout.x) if layout else width // 2
    y = round(height * layout.y) if layout else height - max(18, round(height * .09))
    return size, x, y, round(size * 1.6)


def _outline(layout=None):
    width = 2 if layout is None or layout.outline_width is None else layout.outline_width * layout.font_scale
    if layout is not None and layout.outline_enabled is False:
        width = 0
    color = (layout.outline_color if layout is not None else None) or '#000000'
    return width, color


def _box_outline(style, layout):
    return style == 'box' and layout is not None and any(
        value is not None for value in (layout.outline_enabled, layout.outline_width, layout.outline_color))


def _style(name, size, border, width, color):
    color = color.lstrip('#')
    bgr = color[4:6] + color[2:4] + color[:2]
    return (f'Style: {name},Microsoft YaHei,{size},&H00FFFFFF,&H00FFFFFF,&H00{bgr},&H80000000,'
            f'-1,0,0,0,100,100,0,0,{border},{width:g},0,2,24,24,24,1\n')


def _header(width, height, style, layout=None):
    size = _geometry(width, height, style, layout)[0]
    outline_width, outline_color = _outline(layout)
    boxed = _box_outline(style, layout)
    styles = _style('Default', size, 3 if style == 'box' else 1,
                    max(2, outline_width + 2) if boxed else outline_width, '#000000' if boxed else outline_color)
    if boxed:
        # An ASS opaque box uses OutlineColour for its background. Draw the
        # letter outline independently so changing it never recolors the box.
        styles += _style('OutlineText', size, 1, outline_width, outline_color)
    return ('[Script Info]\nScriptType: v4.00+\n'
            f'PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n'
            '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            + styles +
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')


def _events(document, start_ms, end_ms, width, height, offset_ms=0, style='clean', layout=None):
    colors = {s.speaker_id: s.color for s in document.speakers}
    active, lines = [], []
    _, x, baseline, gap = _geometry(width, height, style, layout)
    boxed = _box_outline(style, layout)
    for cue in sorted(document.subtitles, key=lambda item: (item.start_ms, item.layer)):
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
        y = baseline - slot * gap
        prefix = '{' + f'\\an2\\pos({x},{y})\\1c&H{bgr}&' + '}'
        left, right = start - start_ms + offset_ms, end - start_ms + offset_ms
        if _time(right) == _time(left):
            continue
        text = _text(cue.text)
        if boxed:
            background = prefix[:-1] + '\\1a&HFF&}'
            lines.append(f'Dialogue: {slot},{_time(left)},{_time(right)},Default,,0,0,0,,{background}{text}')
        name = 'OutlineText' if boxed else 'Default'
        lines.append(f'Dialogue: {slot},{_time(left)},{_time(right)},{name},,0,0,0,,{prefix}{text}')
    return lines


def scene_ass(document, scene, width, height, style='clean', layout=None):
    return _header(width, height, style, layout) + '\n'.join(_events(document, round(scene.start * 1000), round(scene.end * 1000), width, height, style=style, layout=layout)) + '\n'


def draft_ass(document, scenes, width=1920, height=1080, style='clean', layout=None):
    from backend.services.studio.audio import scene_duration
    lines, offset = [], 0
    for scene in scenes:
        lines.extend(_events(document, round(scene.start * 1000), round(scene.end * 1000), width, height, offset, style, layout))
        offset += round(scene_duration(scene) * 1000)
    return _header(width, height, style, layout) + '\n'.join(lines) + '\n'
