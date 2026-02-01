import browser from './utils/browser-polyfill';
import * as highlighter from './utils/highlighter';
import { loadSettings, generalSettings } from './utils/storage-utils';
import Defuddle from 'defuddle';
import { getDomain } from './utils/string-utils';
import { createMarkdownContent } from './utils/markdown-converter';

declare global {
	interface Window {
		obsidianHighlighterInitialized?: boolean;
	}
}

// Use a self-executing function to create a closure
// This allows the script to be re-executed without redeclaring variables
(function() {
	// Check if the script has already been initialized
	if (window.hasOwnProperty('obsidianHighlighterInitialized')) {
		return;  // Exit if already initialized
	}

	// Mark as initialized
	window.obsidianHighlighterInitialized = true;

	let isHighlighterMode = false;
	const iframeId = 'obsidian-clipper-iframe';
	const containerId = 'obsidian-clipper-container';

	// Frame selection state (top-level frames only)
	let selectedFrameIndex: number | null = null;
	const frameSelectOverlayId = 'obsidian-clipper-frame-select-overlay';

	function removeContainer(container: HTMLElement) {
		container.classList.add('is-closing');
		container.addEventListener('animationend', () => {
			container.remove();
		}, { once: true });
	}

	async function toggleIframe() {
		const existingContainer = document.getElementById(containerId);
		if (existingContainer) {
			removeContainer(existingContainer);
			return;
		}

		const container = document.createElement('div');
		container.id = containerId;
		container.classList.add('is-open');

		const { clipperIframeWidth, clipperIframeHeight } = await browser.storage.local.get(['clipperIframeWidth', 'clipperIframeHeight']);
		if (clipperIframeWidth) {
			container.style.width = `${clipperIframeWidth}px`;
		}
		if (clipperIframeHeight) {
			container.style.height = `${clipperIframeHeight}px`;
		}

		const iframe = document.createElement('iframe');
		iframe.id = iframeId;
		iframe.src = browser.runtime.getURL('side-panel.html?context=iframe');
		container.appendChild(iframe);

		// Add resize handle (left side only)
		const handle = document.createElement('div');
		handle.className = `obsidian-clipper-resize-handle obsidian-clipper-resize-handle-w`;
		container.appendChild(handle);
		addResizeListener(container, handle, 'w');

		const southHandle = document.createElement('div');
		southHandle.className = `obsidian-clipper-resize-handle obsidian-clipper-resize-handle-s`;
		container.appendChild(southHandle);
		addResizeListener(container, southHandle, 's');

		const southWestHandle = document.createElement('div');
		southWestHandle.className = 'obsidian-clipper-resize-handle obsidian-clipper-resize-handle-sw';
		container.appendChild(southWestHandle);
		addResizeListener(container, southWestHandle, 'sw');

		document.body.appendChild(container);
	}

	function addResizeListener(container: HTMLElement, handle: HTMLElement, direction: string) {
		let isResizing = false;
		let startX: number, startY: number, startWidth: number, startHeight: number, startLeft: number, startTop: number;
	
		handle.onmousedown = (e) => {
			e.stopPropagation();
			isResizing = true;
			startX = e.clientX;
			startY = e.clientY;
			startWidth = container.offsetWidth;
			startHeight = container.offsetHeight;
			startLeft = container.offsetLeft;
			startTop = container.offsetTop;

			document.body.style.cursor = window.getComputedStyle(handle).cursor;
	
			const iframe = container.querySelector('#obsidian-clipper-iframe');
			if (iframe) iframe.classList.add('is-resizing');
	
			document.onmousemove = (moveEvent) => {
				if (!isResizing) return;
	
				const dx = moveEvent.clientX - startX;
				const dy = moveEvent.clientY - startY;

				const minWidth = parseInt(container.style.minWidth) || 200;
				const minHeight = parseInt(container.style.minHeight) || 200;
	
				if (direction.includes('e')) {
					let newWidth = startWidth + dx;
					if (newWidth < minWidth) newWidth = minWidth;
					container.style.width = `${newWidth}px`;
				}
				if (direction.includes('w')) {
					let newWidth = startWidth - dx;
					if (newWidth < minWidth) {
						newWidth = minWidth;
					}
					container.style.width = `${newWidth}px`;
				}
				if (direction.includes('s')) {
					let newHeight = startHeight + dy;
					if (newHeight < minHeight) newHeight = minHeight;
					container.style.height = `${newHeight}px`;
				}
				if (direction.includes('n')) {
					let newHeight = startHeight - dy;
					let newTop = startTop + dy;
					if (newHeight < minHeight) {
						newHeight = minHeight;
						newTop = startTop + startHeight - minHeight;
					}
					container.style.height = `${newHeight}px`;
					container.style.top = `${newTop}px`;
				}
			};
	
			document.onmouseup = () => {
				isResizing = false;
				const iframe = container.querySelector('#obsidian-clipper-iframe');
				if (iframe) iframe.classList.remove('is-resizing');
				document.body.style.cursor = '';
				
				const newWidth = container.offsetWidth;
				const newHeight = container.offsetHeight;
				browser.storage.local.set({ clipperIframeWidth: newWidth, clipperIframeHeight: newHeight });

				document.onmousemove = null;
				document.onmouseup = null;
			};
		};
	}

	// Firefox
	browser.runtime.sendMessage({ action: "contentScriptLoaded" });

	interface ContentResponse {
		content: string;
		selectedHtml: string;
		extractedContent: { [key: string]: string };
		schemaOrgData: any;
		fullHtml: string;
		highlights: string[];
		title: string;
		description: string;
		domain: string;
		favicon: string;
		image: string;
		parseTime: number;
		published: string;
		author: string;
		site: string;
		wordCount: number;
		metaTags: { name?: string | null; property?: string | null; content: string | null }[];
	}

	function cleanupFrameSelectOverlay() {
		const existing = document.getElementById(frameSelectOverlayId);
		if (existing) existing.remove();
		overlayEl = null;
		currentHoverIframe = null;
		document.removeEventListener('keydown', onFrameSelectKeyDown, true);
		document.removeEventListener('mousemove', onFrameSelectMouseMove, true);
		document.removeEventListener('click', onFrameSelectClick, true);
	}

	let currentHoverIframe: HTMLIFrameElement | null = null;
	let overlayEl: HTMLDivElement | null = null;
	let overlayHighlightEl: HTMLDivElement | null = null;
	let overlayHudEl: HTMLDivElement | null = null;

	function ensureFrameSelectOverlay() {
		cleanupFrameSelectOverlay();

		const overlay = document.createElement('div');
		overlay.id = frameSelectOverlayId;
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.zIndex = '2147483647';
		// Capture mouse events even when the pointer is inside an iframe.
		overlay.style.pointerEvents = 'auto';

		const dim = document.createElement('div');
		dim.style.position = 'absolute';
		dim.style.inset = '0';
		dim.style.background = 'rgba(0,0,0,0.35)';
		dim.style.backdropFilter = 'blur(1px)';
		dim.style.pointerEvents = 'auto';
		overlay.appendChild(dim);

		const highlight = document.createElement('div');
		highlight.style.position = 'absolute';
		highlight.style.pointerEvents = 'none';
		highlight.style.border = '2px solid rgba(120, 200, 255, 0.95)';
		highlight.style.background = 'rgba(120, 200, 255, 0.12)';
		highlight.style.borderRadius = '6px';
		highlight.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.0)';
		highlight.style.display = 'none';
		overlay.appendChild(highlight);
		overlayHighlightEl = highlight;

		const hud = document.createElement('div');
		hud.style.position = 'absolute';
		hud.style.top = '12px';
		hud.style.left = '12px';
		hud.style.padding = '10px 12px';
		hud.style.borderRadius = '10px';
		hud.style.background = 'rgba(20,20,20,0.9)';
		hud.style.color = 'white';
		hud.style.fontSize = '13px';
		hud.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
		hud.style.maxWidth = '340px';
		hud.style.pointerEvents = 'none';
		hud.innerHTML = '<div style="font-weight:600; margin-bottom:4px;">Select a frame</div><div>Hover an iframe to highlight it, then click to clip it. Press <b>Esc</b> to cancel.</div>';
		overlay.appendChild(hud);
		overlayHudEl = hud;

		overlayEl = overlay;
		document.documentElement.appendChild(overlay);

		document.addEventListener('keydown', onFrameSelectKeyDown, true);
		document.addEventListener('mousemove', onFrameSelectMouseMove, true);
		document.addEventListener('click', onFrameSelectClick, true);
	}

	function onFrameSelectKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cleanupFrameSelectOverlay();
			browser.runtime.sendMessage({ action: 'frameSelectionCompleted', tabId: (window as any).__obsidianClipperTabId, mode: 'cancel' }).catch(() => {});
		}
	}

	function getIframeAtPointByRects(x: number, y: number): HTMLIFrameElement | null {
		// More robust than elementsFromPoint: some sites use overlays / event retargeting.
		// Pick the smallest iframe that contains the point.
		let best: { el: HTMLIFrameElement; area: number } | null = null;
		for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
			const rect = iframe.getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
				const area = Math.max(0, rect.width) * Math.max(0, rect.height);
				if (!best || area < best.area) {
					best = { el: iframe, area };
				}
			}
		}
		return best?.el || null;
	}

	function onFrameSelectMouseMove(e: MouseEvent) {
		const iframe = getIframeAtPointByRects(e.clientX, e.clientY);
		currentHoverIframe = iframe;
		if (!overlayHighlightEl) return;
		if (!iframe) {
			overlayHighlightEl.style.display = 'none';
			return;
		}
		const rect = iframe.getBoundingClientRect();
		overlayHighlightEl.style.display = 'block';
		overlayHighlightEl.style.left = `${Math.max(0, rect.left)}px`;
		overlayHighlightEl.style.top = `${Math.max(0, rect.top)}px`;
		overlayHighlightEl.style.width = `${Math.max(0, rect.width)}px`;
		overlayHighlightEl.style.height = `${Math.max(0, rect.height)}px`;
	}

	async function onFrameSelectClick(e: MouseEvent) {
		if (!currentHoverIframe) return;
		e.preventDefault();
		e.stopPropagation();

		const iframe = currentHoverIframe;
		cleanupFrameSelectOverlay();

		const iframes = Array.from(document.querySelectorAll('iframe'));
		const index = iframes.indexOf(iframe);
		const rawSrc = iframe.getAttribute('src') || '';

		// Same-origin? If we can access contentDocument, keep it in-place.
		let canAccess = false;
		try {
			canAccess = !!iframe.contentDocument;
		} catch {
			canAccess = false;
		}

		if (canAccess && index >= 0) {
			selectedFrameIndex = index;
			await browser.runtime.sendMessage({ action: 'frameSelectionCompleted', tabId: (window as any).__obsidianClipperTabId, mode: 'same-origin' }).catch(() => {});
			return;
		}

		if (rawSrc && rawSrc !== 'about:blank') {
			try {
				const absUrl = new URL(rawSrc, document.baseURI).href;
				await browser.runtime.sendMessage({ action: 'frameSelectionCompleted', tabId: (window as any).__obsidianClipperTabId, mode: 'open-url', url: absUrl }).catch(() => {});
				return;
			} catch (err) {
				// fallthrough
			}
		}

		await browser.runtime.sendMessage({ action: 'frameSelectionCompleted', tabId: (window as any).__obsidianClipperTabId, mode: 'error', error: 'Selected iframe is not accessible and has no usable src.' }).catch(() => {});
	}

	function startFrameSelectionMode(senderTabId?: number) {
		// Store tab id for callbacks back to background
		(window as any).__obsidianClipperTabId = senderTabId;
		ensureFrameSelectOverlay();
	}

	function buildPageContentResponse(docToParse: Document, url: string, selectedHtml: string): ContentResponse {
		const extractedContent: { [key: string]: string } = {};
		const defuddled = new Defuddle(docToParse, { url }).parse();

		const parser = new DOMParser();
		const doc = parser.parseFromString(docToParse.documentElement.outerHTML, 'text/html');
		doc.querySelectorAll('script, style').forEach(el => el.remove());
		doc.querySelectorAll('*').forEach(el => el.removeAttribute('style'));
		doc.querySelectorAll('[src], [href]').forEach(element => {
			['src', 'href', 'srcset'].forEach(attr => {
				const value = element.getAttribute(attr);
				if (!value) return;
				if (attr === 'srcset') {
					const newSrcset = value.split(',').map(src => {
						const [u, size] = src.trim().split(' ');
						try {
							const absoluteUrl = new URL(u, url).href;
							return `${absoluteUrl}${size ? ' ' + size : ''}`;
						} catch {
							return src;
						}
					}).join(', ');
					element.setAttribute(attr, newSrcset);
				} else if (!value.startsWith('http') && !value.startsWith('data:') && !value.startsWith('#') && !value.startsWith('//')) {
					try {
						const absoluteUrl = new URL(value, url).href;
						element.setAttribute(attr, absoluteUrl);
					} catch {
						// ignore
					}
				}
			});
		});

		const cleanedHtml = doc.documentElement.outerHTML;

		return {
			author: defuddled.author,
			content: defuddled.content,
			description: defuddled.description,
			domain: getDomain(url),
			extractedContent,
			favicon: defuddled.favicon,
			fullHtml: cleanedHtml,
			highlights: highlighter.getHighlights(),
			image: defuddled.image,
			parseTime: defuddled.parseTime,
			published: defuddled.published,
			schemaOrgData: defuddled.schemaOrgData,
			selectedHtml,
			site: defuddled.site,
			title: defuddled.title,
			wordCount: defuddled.wordCount,
			metaTags: defuddled.metaTags || []
		};
	}

	browser.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
		if (request.action === "ping") {
			sendResponse({});
			return true;
		}

		if (request.action === "startFrameSelection") {
			startFrameSelectionMode(sender?.tab?.id);
			sendResponse({ success: true });
			return true;
		}

		if (request.action === "toggle-iframe") {
			toggleIframe().then(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === "close-iframe") {
			const existingContainer = document.getElementById(containerId);
			if (existingContainer) {
				removeContainer(existingContainer);
			}
			return;
		}

		if (request.action === "copy-text-to-clipboard") {
			const textArea = document.createElement("textarea");
			textArea.value = request.text;
			document.body.appendChild(textArea);
			textArea.select();
			try {
				document.execCommand('copy');
				sendResponse({success: true});
			} catch (err) {
				sendResponse({success: false});
			}
			document.body.removeChild(textArea);
			return true;
		}

		if (request.action === "copyMarkdownToClipboard") {
			try {
				// Extract page content using Defuddle
				const defuddled = new Defuddle(document, { url: document.URL }).parse();

				// Convert HTML content to markdown
				const markdown = createMarkdownContent(defuddled.content, document.URL);

				// Copy to clipboard
				const textArea = document.createElement("textarea");
				textArea.value = markdown;
				document.body.appendChild(textArea);
				textArea.select();
				document.execCommand('copy');
				document.body.removeChild(textArea);

				sendResponse({ success: true });
			} catch (err) {
				console.error('Failed to copy markdown to clipboard:', err);
				sendResponse({ success: false, error: (err as Error).message });
			}
			return true;
		}

		if (request.action === "getPageContent") {
			let selectedHtml = '';
			const selection = window.getSelection();

			if (selection && selection.rangeCount > 0) {
				const range = selection.getRangeAt(0);
				const clonedSelection = range.cloneContents();
				const div = document.createElement('div');
				div.appendChild(clonedSelection);
				selectedHtml = div.innerHTML;
			}

			try {
				// If a frame was selected and is same-origin, extract from that frame's document.
				if (selectedFrameIndex !== null) {
					const frameIndex = selectedFrameIndex;
					const iframe = Array.from(document.querySelectorAll('iframe'))[frameIndex] as HTMLIFrameElement | undefined;
					if (iframe) {
						let frameDoc: Document | null = null;
						try {
							frameDoc = iframe.contentDocument;
						} catch {
							frameDoc = null;
						}

						if (frameDoc) {
							const frameUrl = frameDoc.URL || (iframe.getAttribute('src') ? new URL(iframe.getAttribute('src') as string, document.baseURI).href : document.URL);
							const response = buildPageContentResponse(frameDoc, frameUrl, '');
							sendResponse(response);
							selectedFrameIndex = null; // one-shot
							return true;
						}
					}
					// If we can't access it (should be rare because selection checks), fall back to page.
					selectedFrameIndex = null;
				}

				const response = buildPageContentResponse(document, document.URL, selectedHtml);
				sendResponse(response);
			} catch (err) {
				console.error('Error building page content response:', err);
				sendResponse({
					content: '',
					selectedHtml: '',
					extractedContent: {},
					schemaOrgData: null,
					fullHtml: '',
					highlights: [],
					title: '',
					description: '',
					domain: getDomain(document.URL),
					favicon: '',
					image: '',
					parseTime: 0,
					published: '',
					author: '',
					site: '',
					wordCount: 0,
					metaTags: []
				});
			}
		} else if (request.action === "extractContent") {
			const content = extractContentBySelector(request.selector, request.attribute, request.extractHtml);
			sendResponse({ content: content });
		} else if (request.action === "paintHighlights") {
			highlighter.loadHighlights().then(() => {
				if (generalSettings.alwaysShowHighlights) {
					highlighter.applyHighlights();
				}
				sendResponse({ success: true });
			});
			return true;
		} else if (request.action === "setHighlighterMode") {
			isHighlighterMode = request.isActive;
			highlighter.toggleHighlighterMenu(isHighlighterMode);
			updateHasHighlights();
			sendResponse({ success: true });
			return true;
		} else if (request.action === "getHighlighterMode") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" }).then(sendResponse);
			return true;
		} else if (request.action === "toggleHighlighter") {
			highlighter.toggleHighlighterMenu(request.isActive);
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightSelection") {
			highlighter.toggleHighlighterMenu(request.isActive);
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) {
				highlighter.handleTextSelection(selection);
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightElement") {
			highlighter.toggleHighlighterMenu(request.isActive);
			if (request.targetElementInfo) {
				const { mediaType, srcUrl, pageUrl } = request.targetElementInfo;
				
				let elementToHighlight: Element | null = null;

				// Function to compare URLs, handling both absolute and relative paths
				const urlMatches = (elementSrc: string, targetSrc: string) => {
					const elementUrl = new URL(elementSrc, pageUrl);
					const targetUrl = new URL(targetSrc, pageUrl);
					return elementUrl.href === targetUrl.href;
				};

				// Try to find the element using the src attribute
				elementToHighlight = document.querySelector(`${mediaType}[src="${srcUrl}"]`);

				// If not found, try with relative URL
				if (!elementToHighlight) {
					const relativeSrc = new URL(srcUrl).pathname;
					elementToHighlight = document.querySelector(`${mediaType}[src="${relativeSrc}"]`);
				}

				// If still not found, iterate through all elements of the media type
				if (!elementToHighlight) {
					const elements = Array.from(document.getElementsByTagName(mediaType));
					for (const el of elements) {
						if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
							if (urlMatches(el.src, srcUrl)) {
								elementToHighlight = el;
								break;
							}
						}
					}
				}

				if (elementToHighlight) {
					const xpath = highlighter.getElementXPath(elementToHighlight);
					highlighter.highlightElement(elementToHighlight);
				} else {
					console.warn('Could not find element to highlight. Info:', request.targetElementInfo);
				}
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "clearHighlights") {
			highlighter.clearHighlights();
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "getHighlighterState") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" })
				.then(response => {
					sendResponse(response);
				})
				.catch(error => {
					console.error("Error getting highlighter mode:", error);
					sendResponse({ isActive: false });
				});
			return true;
		} else if (request.action === "toggleReaderMode") {
			// Forward the request to the background script to inject reader mode if needed
			browser.runtime.sendMessage({ action: "toggleReaderMode", tabId: sender.tab?.id })
				.then(sendResponse)
				.catch(error => {
					console.error("Error toggling reader mode:", error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
				});
			return true;
		}
		return true;
	});

	function extractContentBySelector(selector: string, attribute?: string, extractHtml: boolean = false): string | string[] {
		try {
			const elements = document.querySelectorAll(selector);
			
			if (elements.length > 1) {
				return Array.from(elements).map(el => {
					if (attribute) {
						return el.getAttribute(attribute) || '';
					}
					return extractHtml ? el.outerHTML : el.textContent?.trim() || '';
				});
			} else if (elements.length === 1) {
				if (attribute) {
					return elements[0].getAttribute(attribute) || '';
				}
				return extractHtml ? elements[0].outerHTML : elements[0].textContent?.trim() || '';
			} else {
				console.log(`No elements found for selector: ${selector}`);
				return '';
			}
		} catch (error) {
			console.error('Error in extractContentBySelector:', error, { selector, attribute, extractHtml });
			return '';
		}
	}

	function updateHasHighlights() {
		const hasHighlights = highlighter.getHighlights().length > 0;
		browser.runtime.sendMessage({ action: "updateHasHighlights", hasHighlights });
	}

	async function initializeHighlighter() {
		await loadSettings();
		await highlighter.loadHighlights();
		
		if (generalSettings.alwaysShowHighlights) {
			highlighter.applyHighlights();
		}
		
		updateHasHighlights();
	}

	// Initialize highlighter
	initializeHighlighter();

	// Call updateHasHighlights when the page loads
	window.addEventListener('load', updateHasHighlights);

	// Deactivate highlighter mode on unload
	function handlePageUnload() {
		if (isHighlighterMode) {
			highlighter.toggleHighlighterMenu(false);
			browser.runtime.sendMessage({ action: "highlighterModeChanged", isActive: false });
			browser.storage.local.set({ isHighlighterMode: false });
		}
	}

	window.addEventListener('beforeunload', handlePageUnload);

	// Listen for custom events from the reader script
	document.addEventListener('obsidian-reader-init', async () => {
		// Find the highlighter button
		const button = document.querySelector('[data-action="toggle-highlighter"]');
		if (button) {
			// Handle highlighter button clicks
			button.addEventListener('click', async (e) => {
				try {
					// First try to get the tab ID from the background script
					const response = await browser.runtime.sendMessage({ action: "ensureContentScriptLoaded" });
					
					let tabId: number | undefined;
					if (response && typeof response === 'object') {
						tabId = (response as { tabId: number }).tabId;
					}

					// If we didn't get a tab ID, try to get it from the background script
					if (!tabId) {
						try {
							const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
							if (response && !response.error && response.tabId) {
								tabId = response.tabId;
							}
						} catch (error) {
							console.error('[Content] Failed to get tab ID from background script:', error);
						}
					}

					if (tabId) {
						await browser.runtime.sendMessage({ action: "toggleHighlighterMode", tabId });
					} else {
						console.error('[Content]','Could not determine tab ID');
					}
				} catch (error) {
					console.error('[Content]','Error in toggle flow:', error);
				}
			});
		}
	});

})();
