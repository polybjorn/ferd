"""Validation of the category_labels payload."""

from __future__ import annotations

from .common import PATH_COMPONENT_RE, ValidationError


def clean_category_labels(labels):
  """Validate a category_labels payload. Shape: {slug: {label, color?}}.
  Raises ValidationError (-> 400) on bad input."""
  if not isinstance(labels, dict):
    raise ValidationError("category_labels must be an object")
  if len(labels) > 200:
    raise ValidationError("too many category labels (max 200)")
  cleaned: dict[str, dict] = {}
  for slug, value in labels.items():
    if not isinstance(slug, str):
      raise ValidationError("category_labels keys must be strings")
    slug_clean = slug.strip()
    if not slug_clean:
      continue
    if len(slug_clean) > 64:
      raise ValidationError(f"slug too long: {slug_clean[:32]}...")
    if not PATH_COMPONENT_RE.match(slug_clean):
      raise ValidationError(f"slug contains disallowed characters: {slug_clean}")
    if not isinstance(value, dict):
      raise ValidationError(f"category_labels['{slug_clean}'] must be an object")
    display = value.get("label", "")
    if not isinstance(display, str):
      raise ValidationError(f"label for '{slug_clean}' must be a string")
    color = value.get("color")
    if color is not None:
      if not isinstance(color, int) or isinstance(color, bool):
        raise ValidationError(f"color for '{slug_clean}' must be an integer")
      if color < 0 or color > 99:
        raise ValidationError(f"color for '{slug_clean}' out of range [0, 99]")
    order = value.get("order")
    if order is not None:
      if not isinstance(order, int) or isinstance(order, bool):
        raise ValidationError(f"order for '{slug_clean}' must be an integer")
      if order < 0 or order > 999:
        raise ValidationError(f"order for '{slug_clean}' out of range [0, 999]")
    extra = set(value.keys()) - {"label", "color", "order"}
    if extra:
      raise ValidationError(f"unknown key(s) for '{slug_clean}': {', '.join(sorted(extra))}")
    display_clean = display.strip()
    if not display_clean:
      continue
    if len(display_clean) > 80:
      raise ValidationError(f"display too long for slug '{slug_clean}'")
    entry: dict = {"label": display_clean}
    if color is not None:
      entry["color"] = color
    if order is not None:
      entry["order"] = order
    cleaned[slug_clean] = entry
  return cleaned
