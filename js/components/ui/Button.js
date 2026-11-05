const VARIANTS = new Set(['default', 'secondary', 'ghost', 'destructive', 'destructive-ghost']);
const SIZES = new Set(['sm', 'md', 'lg']);
const TYPES = new Set(['button', 'submit', 'reset']);
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect',
]);
const ICON_ELEMENTS = new Set([...SVG_ELEMENTS, 'i', 'span']);
const SVG_ATTRIBUTES = new Set([
  'aria-label', 'class', 'cx', 'cy', 'd', 'fill', 'fill-rule', 'height', 'opacity',
  'points', 'r', 'rx', 'ry', 'stroke', 'stroke-linecap', 'stroke-linejoin',
  'stroke-width', 'transform', 'viewBox', 'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
]);

function sanitizeIconElement(root) {
  const elements = [root, ...root.querySelectorAll('*')];
  for (const element of elements) {
    if (!ICON_ELEMENTS.has(element.localName)) {
      element.remove();
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const allowedAttribute = SVG_ATTRIBUTES.has(attribute.name)
        || (['i', 'span'].includes(element.localName) && attribute.name === 'aria-hidden');
      if (!allowedAttribute || /url\s*\(|javascript:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return root;
}

function createIconContent(icon, doc) {
  if (!icon) return null;

  if (typeof icon === 'string') {
    const template = doc.createElement('template');
    template.innerHTML = icon;
    const element = template.content.firstElementChild;
    return element ? sanitizeIconElement(element) : doc.createTextNode(icon);
  }

  if (typeof icon === 'object' && typeof icon.nodeType === 'number') {
    const clone = icon.cloneNode(true);
    if (!ICON_ELEMENTS.has(clone.localName)) throw new TypeError('El elemento icon debe ser SVG, i o span.');
    return sanitizeIconElement(clone);
  }

  throw new TypeError('icon debe ser una cadena SVG o un elemento DOM.');
}

/**
 * Crea un botón accesible con las variantes y tamaños compartidos de la aplicación.
 * El icono en formato HTML se limita a elementos SVG y atributos visuales seguros.
 *
 * @param {object} options
 * @param {string} [options.text] Texto visible del botón.
 * @param {'default'|'secondary'|'ghost'|'destructive'|'destructive-ghost'} [options.variant='default']
 * @param {'sm'|'md'|'lg'} [options.size='md']
 * @param {string|Element} [options.icon] SVG en cadena o elemento SVG.
 * @param {(event: MouseEvent) => void} [options.onClick]
 * @param {'button'|'submit'|'reset'} [options.type='button']
 * @param {boolean} [options.disabled=false]
 * @param {string} [options.id]
 * @param {string} [options.className] Clases adicionales separadas por espacios.
 * @param {string} [options.ariaLabel] Nombre accesible para botones solo con icono.
 * @returns {HTMLButtonElement}
 */
export function createButton({
  text,
  variant = 'default',
  size = 'md',
  icon,
  onClick,
  type = 'button',
  disabled = false,
  id,
  className = '',
  ariaLabel,
} = {}) {
  if (!VARIANTS.has(variant)) throw new TypeError(`Variante de botón no válida: ${variant}`);
  if (!SIZES.has(size)) throw new TypeError(`Tamaño de botón no válido: ${size}`);
  if (!TYPES.has(type)) throw new TypeError(`Tipo de botón no válido: ${type}`);
  if (text !== undefined && typeof text !== 'string') throw new TypeError('text debe ser una cadena.');
  if (onClick !== undefined && typeof onClick !== 'function') throw new TypeError('onClick debe ser una función.');
  if (typeof className !== 'string') throw new TypeError('className debe ser una cadena.');

  const doc = document;
  const button = doc.createElement('button');
  const hasText = typeof text === 'string' && text.trim().length > 0;
  button.type = type;
  button.disabled = Boolean(disabled);
  button.setAttribute('aria-disabled', String(button.disabled));
  button.classList.add('ui-button', `ui-button--${variant}`, `ui-button--${size}`);
  if (icon && !hasText) button.classList.add('ui-button--icon');
  if (className) button.classList.add(...className.split(/\s+/).filter(Boolean));
  if (id) button.id = id;

  const iconContent = createIconContent(icon, doc);
  if (iconContent) {
    const iconWrapper = doc.createElement('span');
    iconWrapper.className = 'ui-button__icon';
    iconWrapper.setAttribute('aria-hidden', 'true');
    iconWrapper.append(iconContent);
    button.append(iconWrapper);
  }

  if (hasText) {
    const label = doc.createElement('span');
    label.className = 'ui-button__text';
    label.textContent = text;
    button.append(label);
  } else if (iconContent) {
    const iconLabel = iconContent.getAttribute?.('aria-label');
    button.setAttribute('aria-label', ariaLabel || iconLabel || 'Acción');
  } else if (ariaLabel) {
    button.setAttribute('aria-label', ariaLabel);
  }

  if (onClick) button.addEventListener('click', onClick);
  return button;
}
