// Presentation only: source text remains unchanged in the API and database.
(() => {
  const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let parser;
  if (window.marked) {
    const renderer = new window.marked.Renderer();
    renderer.html = ({ text }) => escape(text); // Never interpret raw HTML.
    renderer.image = ({ text }) => escape(`[Image: ${text || 'omitted'}]`); // No tracking images/network requests.
    parser = new window.marked.Marked({ renderer, gfm: true, breaks: false, async: false });
  }
  window.PiMarkdown = {
    render(element, text) {
      if (!parser || !window.DOMPurify?.isSupported) return false;
      try {
        const fragment = window.DOMPurify.sanitize(parser.parse(text), {
          RETURN_DOM_FRAGMENT: true,
          ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'a', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
          ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
          ALLOW_DATA_ATTR: false,
          ALLOW_ARIA_ATTR: false,
        });
        element.replaceChildren(fragment);
        return true;
      } catch {
        // Fail closed: callers display the original text if rendering fails.
        element.replaceChildren();
        return false;
      }
    },
  };
})();
