/**
 * Schwimmerschalter-Konfigurator – Frontend-Logik (Vanilla JS).
 *
 * Baut das UI aus SSK_DATA.schema auf, pflegt eine Live-Zusammenfassung
 * und bietet zwei Aktionen:
 *   B) "Konfiguration herunterladen"  -> POST /ssk/v1/pdf      (ohne Kontaktdaten)
 *   A) "Anfrage absenden"             -> POST /ssk/v1/anfrage  (mit Kontaktdaten)
 */
(function () {
	'use strict';

	if (typeof window.SSK_DATA === 'undefined') {
		return;
	}

	var OTHER = '__other__';

	/* ----------------------------- Helpers ------------------------------ */

	function el(tag, attrs, children) {
		var n = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (k) {
				if (k === 'class') { n.className = attrs[k]; }
				else if (k === 'text') { n.textContent = attrs[k]; }
				else if (k === 'html') { n.innerHTML = attrs[k]; }
				else if (attrs[k] === true) { n.setAttribute(k, k); }
				else if (attrs[k] !== false && attrs[k] != null) { n.setAttribute(k, attrs[k]); }
			});
		}
		if (children != null) {
			(Array.isArray(children) ? children : [children]).forEach(function (c) {
				if (c == null) { return; }
				n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
			});
		}
		return n;
	}

	function isNumeric(v) {
		if (v === '' || v == null) { return false; }
		return !isNaN(parseFloat(String(v).replace(',', '.'))) && isFinite(String(v).replace(',', '.'));
	}

	function downloadBase64Pdf(b64, filename) {
		var binary = atob(b64);
		var len = binary.length;
		var arr = new Uint8Array(len);
		for (var i = 0; i < len; i++) { arr[i] = binary.charCodeAt(i); }
		var blob = new Blob([arr], { type: 'application/pdf' });
		var url = URL.createObjectURL(blob);
		var a = el('a', { href: url, download: filename || 'konfiguration.pdf' });
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
	}

	function readFileAsBase64(file) {
		return new Promise(function (resolve, reject) {
			var reader = new FileReader();
			reader.onload = function () {
				var res = String(reader.result);
				var comma = res.indexOf(',');
				resolve(comma >= 0 ? res.substring(comma + 1) : res);
			};
			reader.onerror = function () { reject(reader.error); };
			reader.readAsDataURL(file);
		});
	}

	/* --------------------------- Configurator --------------------------- */

	function Configurator(root, data) {
		this.root = root;
		this.data = data;
		this.lang = data.lang || 'de';
		this.s = data.strings || {};
		this.renderTs = Date.now();

		this.groupRefs = {};   // sectionId -> { fieldId: ref }
		this.repeaters = {};   // sectionId -> { def, container, items: [ {fieldId: ref} ] }
		this.contactRefs = {}; // fieldId -> ref
		this.lastPdf = null;

		this.build();
	}

	Configurator.prototype.build = function () {
		var self = this;
		this.root.innerHTML = '';

		// Lottie: alte Instanzen aufräumen, Warteschlange leeren.
		(this.animInstances || []).forEach(function (a) { try { a.destroy(); } catch (e) {} });
		this.animInstances = [];
		this.animQueue = [];

		// Logo rechts oben (falls konfiguriert).
		if (this.data.logoUrl) {
			this.root.appendChild(
				el('div', { 'class': 'ssk-header' }, [
					el('img', { 'class': 'ssk-logo', src: this.data.logoUrl, alt: '' })
				])
			);
		}

		this.formCol = el('div', { 'class': 'ssk-form' });
		this.summaryCol = el('div', { 'class': 'ssk-summary' });

		// Sektionen aufbauen.
		(this.data.schema || []).forEach(function (section) {
			self.formCol.appendChild(
				section.type === 'repeater' ? self.buildRepeater(section) : self.buildGroup(section)
			);
		});

		// Kontaktblock (für Aktion A) – zunächst versteckt.
		this.contactBlock = this.buildContact();
		this.formCol.appendChild(this.contactBlock);

		// Zusammenfassung + Aktionen.
		this.summaryCol.appendChild(el('h3', { 'class': 'ssk-summary__title', text: this.s.summaryHeading || 'Zusammenfassung' }));
		this.summaryBody = el('div', { 'class': 'ssk-summary__body' });
		this.messageBox = el('div', { 'class': 'ssk-message-area', 'aria-live': 'polite' });
		this.actions = el('div', { 'class': 'ssk-actions' });

		this.btnDownload = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--secondary', text: this.s.btnDownload || 'PDF herunterladen' });
		this.btnRequest = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--primary', text: this.s.btnRequestOpen || 'Anfrage absenden' });

		this.btnReset = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--ghost ssk-btn--reset', text: this.s.btnReset || 'Zurücksetzen' });

		this.btnDownload.addEventListener('click', function () { self.onDownload(); });
		this.btnRequest.addEventListener('click', function () { self.onRequestOpen(); });
		this.btnReset.addEventListener('click', function () {
			if (window.confirm(self.s.resetConfirm || 'Alle Eingaben löschen?')) { self.reset(); }
		});

		this.actions.appendChild(this.btnDownload);
		this.actions.appendChild(this.btnRequest);
		this.actions.appendChild(this.btnReset);

		// Honeypot.
		this.honeypot = el('input', { type: 'text', name: 'ssk_hp', tabindex: '-1', autocomplete: 'off' });
		var hpWrap = el('div', { 'class': 'ssk-hp', 'aria-hidden': 'true' }, [
			el('label', {}, ['Bitte leer lassen', this.honeypot])
		]);

		this.summaryCol.appendChild(this.summaryBody);
		this.summaryCol.appendChild(this.messageBox);
		this.summaryCol.appendChild(this.actions);
		this.summaryCol.appendChild(hpWrap);

		var layout = el('div', { 'class': 'ssk-layout' }, [this.formCol, this.summaryCol]);
		this.root.appendChild(layout);

		// Globale Change-Listener (nur einmal anhängen, überlebt ein reset/build).
		if (!this._wired) {
			this._wired = true;
			this.root.addEventListener('input', function () { self.onChange(); });
			this.root.addEventListener('change', function () { self.onChange(); });
		}

		this.initAnimations();
		this.onChange();
	};

	Configurator.prototype.labelForValue = function (def, value) {
		var found = value;
		(def.options || []).forEach(function (o) { if (String(o.value) === String(value)) { found = o.label; } });
		return found;
	};

	Configurator.prototype.initAnimations = function () {
		var self = this;
		if (!window.lottie || !this.animQueue || !this.animQueue.length) { return; }
		this.animQueue.forEach(function (item) {
			try {
				var cfg = { container: item.holder, renderer: 'svg', loop: true, autoplay: true };
				if (item.data) { cfg.animationData = item.data; } else { cfg.path = item.src; }
				self.animInstances.push(window.lottie.loadAnimation(cfg));
			} catch (e) { if (window.console) { console.warn('SSK Lottie:', e); } }
		});
	};

	Configurator.prototype.updateAnimations = function () {
		var self = this;
		(this.data.schema || []).forEach(function (section) {
			if (section.type === 'repeater') { return; }
			var refs = self.groupRefs[section.id];
			if (!refs) { return; }
			section.fields.forEach(function (def) {
				var ref = refs[def.id];
				if (!ref || !ref.animItems) { return; }
				var val = ref.input.value;
				var anySelected = val !== '';
				ref.animItems.forEach(function (it) {
					it.box.classList.toggle('ssk-anim-box--active', anySelected && it.value === val);
					it.box.classList.toggle('ssk-anim-box--dim', anySelected && it.value !== val);
				});
			});
		});
	};

	// Konfigurator komplett auf den Ausgangszustand zurücksetzen.
	Configurator.prototype.reset = function () {
		this.lastPdf = null;
		this.renderTs = Date.now();
		this.groupRefs = {};
		this.repeaters = {};
		this.contactRefs = {};
		this.build();
		this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
	};

	/* ------------------------------ Felder ------------------------------ */

	Configurator.prototype.buildField = function (def, sectionId) {
		var self = this;
		var ref = { def: def, sectionId: sectionId, input: null, otherInput: null };

		var wrapper = el('div', { 'class': 'ssk-field ssk-field--' + def.type, 'data-field': def.id });
		ref.wrapper = wrapper;

		// Optionale Animationen oberhalb des Feldes (z. B. Ausrichtung).
		if (def.animations && def.animations.length) {
			ref.animItems = [];
			var animRow = el('div', { 'class': 'ssk-anim-row' });
			def.animations.forEach(function (a) {
				var holder = el('div', { 'class': 'ssk-anim' });
				var caption = el('div', { 'class': 'ssk-anim-caption', text: self.labelForValue(def, a.value) });
				var box = el('div', { 'class': 'ssk-anim-box', role: 'button', tabindex: '0', title: self.labelForValue(def, a.value) }, [holder, caption]);
				box.addEventListener('click', function () {
					ref.input.value = a.value;
					ref.input.dispatchEvent(new Event('change', { bubbles: true }));
				});
				box.addEventListener('keydown', function (e) {
					if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
				});
				animRow.appendChild(box);
				ref.animItems.push({ value: a.value, box: box });
				self.animQueue.push({ holder: holder, src: a.src, data: a.data });
			});
			wrapper.appendChild(animRow);
		}

		if (def.type === 'checkbox') {
			ref.input = el('input', { type: 'checkbox' });
			wrapper.appendChild(el('label', {}, [ref.input, ' ' + def.label]));
		} else {
			var labelChildren = [def.label];
			if (def.required) { labelChildren.push(el('span', { 'class': 'ssk-req', text: '*' })); }
			else { labelChildren.push(el('span', { 'class': 'ssk-optional', text: '(' + (this.s.optional || 'optional') + ')' })); }
			wrapper.appendChild(el('label', { 'class': 'ssk-field__label' }, labelChildren));

			if (def.type === 'select') {
				ref.input = this.buildSelect(def);
				wrapper.appendChild(ref.input);

				if (def.allowOther) {
					ref.otherInput = el('input', { type: 'text', 'class': 'ssk-other', placeholder: this.s.otherLabel || 'Andere …' });
					ref.otherInput.style.display = 'none';
					wrapper.appendChild(ref.otherInput);
				}
			} else if (def.type === 'textarea') {
				ref.input = el('textarea', {});
				wrapper.appendChild(ref.input);
			} else if (def.type === 'number') {
				ref.input = el('input', { type: 'number' });
				if (def.min != null) { ref.input.setAttribute('min', def.min); }
				if (def.unit) {
					wrapper.appendChild(el('div', { 'class': 'ssk-input-unit' }, [ref.input, el('span', { 'class': 'ssk-unit', text: def.unit })]));
				} else {
					wrapper.appendChild(ref.input);
				}
			} else { // text, email, tel, url
				ref.input = el('input', { type: def.type === 'email' ? 'email' : (def.type === 'tel' ? 'tel' : 'text') });
				wrapper.appendChild(ref.input);
			}
		}

		wrapper.appendChild(el('div', { 'class': 'ssk-field__error' }));

		ref.getValue = function () {
			if (def.type === 'checkbox') { return ref.input.checked; }
			return ref.input.value;
		};
		ref.getOther = function () { return ref.otherInput ? ref.otherInput.value.trim() : ''; };

		return ref;
	};

	Configurator.prototype.buildSelect = function (def) {
		var sel = el('select', {});
		sel.appendChild(el('option', { value: '' }, [this.s.pleaseSelect || 'Bitte wählen …']));
		(def.options || []).forEach(function (opt) {
			sel.appendChild(el('option', { value: opt.value }, [opt.label]));
		});
		if (def.allowOther) {
			sel.appendChild(el('option', { value: OTHER }, [this.s.otherLabel || 'Andere …']));
		}
		return sel;
	};

	Configurator.prototype.buildGroup = function (section) {
		var self = this;
		this.groupRefs[section.id] = {};
		var body = el('div', {});
		section.fields.forEach(function (def) {
			var ref = self.buildField(def, section.id);
			self.groupRefs[section.id][def.id] = ref;
			body.appendChild(ref.wrapper);
		});
		return el('div', { 'class': 'ssk-section', 'data-section': section.id }, [
			el('h3', { 'class': 'ssk-section__title', text: section.label }),
			body
		]);
	};

	/* ----------------------------- Repeater ----------------------------- */

	Configurator.prototype.buildRepeater = function (section) {
		var self = this;
		var container = el('div', { 'class': 'ssk-repeater' });
		this.repeaters[section.id] = { def: section, container: container, items: [] };

		var addBtn = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--ghost ssk-btn--small', text: this.s.addSwitchPoint || 'Hinzufügen' });
		addBtn.addEventListener('click', function () {
			var rep = self.repeaters[section.id];
			if (rep.items.length < section.max) {
				self.addRepeaterItem(section);
				self.refreshRepeaterUi(section);
				self.onChange();
			}
		});
		this.repeaters[section.id].addBtn = addBtn;

		var sectionEl = el('div', { 'class': 'ssk-section', 'data-section': section.id }, [
			el('h3', { 'class': 'ssk-section__title', text: section.label }),
			container,
			addBtn
		]);

		// Mindestanzahl initial anlegen.
		var min = section.min || 1;
		for (var i = 0; i < min; i++) { this.addRepeaterItem(section); }
		this.refreshRepeaterUi(section);

		return sectionEl;
	};

	Configurator.prototype.addRepeaterItem = function (section) {
		var self = this;
		var rep = this.repeaters[section.id];
		var itemRefs = {};

		var grid = el('div', { 'class': 'ssk-repeater-grid' });
		section.fields.forEach(function (def) {
			var ref = self.buildField(def, section.id);
			itemRefs[def.id] = ref;
			grid.appendChild(ref.wrapper);
		});

		var head = el('div', { 'class': 'ssk-repeater-item__head' });
		var removeBtn = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--ghost ssk-btn--small', text: this.s.removeSwitchPoint || 'Entfernen' });
		removeBtn.addEventListener('click', function () {
			if (rep.items.length > (section.min || 1)) {
				var idx = rep.items.indexOf(entry);
				if (idx >= 0) { rep.items.splice(idx, 1); }
				wrap.remove();
				self.refreshRepeaterUi(section);
				self.onChange();
			}
		});

		var titleSpan = el('span', {});
		head.appendChild(titleSpan);
		head.appendChild(removeBtn);

		var wrap = el('div', { 'class': 'ssk-repeater-item' }, [head, grid]);
		var entry = { refs: itemRefs, wrap: wrap, titleSpan: titleSpan, removeBtn: removeBtn };
		rep.items.push(entry);
		rep.container.appendChild(wrap);
	};

	Configurator.prototype.refreshRepeaterUi = function (section) {
		var rep = this.repeaters[section.id];
		var label = section.itemLabel || this.s.switchPoint || 'Punkt';
		rep.items.forEach(function (entry, i) {
			entry.titleSpan.textContent = label + ' ' + (i + 1);
			entry.removeBtn.style.display = (rep.items.length > (section.min || 1)) ? '' : 'none';
		});
		if (rep.addBtn) {
			rep.addBtn.style.display = (rep.items.length < section.max) ? '' : 'none';
		}
	};

	/* ------------------------------ Kontakt ----------------------------- */

	Configurator.prototype.buildContact = function () {
		var self = this;
		var body = el('div', {});

		(this.data.contact || []).forEach(function (def) {
			var ref = self.buildField(def, '__contact__');
			self.contactRefs[def.id] = ref;
			body.appendChild(ref.wrapper);
		});

		// Optionaler Datei-Upload.
		if (this.data.upload && this.data.upload.enabled) {
			var fileWrap = el('div', { 'class': 'ssk-field', 'data-field': 'upload' });
			fileWrap.appendChild(el('label', { 'class': 'ssk-field__label' }, [
				(this.lang === 'en' ? 'Attachment (optional)' : 'Datei-Anhang (optional)'),
				el('span', { 'class': 'ssk-optional', text: '(' + (this.s.optional || 'optional') + ')' })
			]));
			this.fileInput = el('input', { type: 'file', accept: this.data.upload.accept || '' });
			fileWrap.appendChild(this.fileInput);
			fileWrap.appendChild(el('div', { 'class': 'ssk-field__error' }));
			this.uploadWrap = fileWrap;
			body.appendChild(fileWrap);
		}

		// Datenschutz-Checkbox.
		var privacyLabelText = this.lang === 'en'
			? 'I have read and accept the privacy policy.'
			: 'Ich habe die Datenschutzerklärung gelesen und stimme ihr zu.';
		this.privacyInput = el('input', { type: 'checkbox' });
		var privacyLabelChildren = [this.privacyInput, ' ' + privacyLabelText];
		if (this.data.privacyUrl) {
			privacyLabelChildren.push(' ');
			privacyLabelChildren.push(el('a', { href: this.data.privacyUrl, target: '_blank', rel: 'noopener' }, [this.lang === 'en' ? 'Privacy policy' : 'Datenschutz']));
		}
		this.privacyWrap = el('div', { 'class': 'ssk-field ssk-field--checkbox', 'data-field': 'datenschutz' }, [
			el('label', {}, privacyLabelChildren),
			el('div', { 'class': 'ssk-field__error' })
		]);
		body.appendChild(this.privacyWrap);

		// Buttons im Kontaktblock.
		var btnSend = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--primary', text: this.s.btnRequest || 'Anfrage absenden' });
		var btnBack = el('button', { type: 'button', 'class': 'ssk-btn ssk-btn--ghost', text: this.s.btnBack || 'Zurück' });
		btnSend.addEventListener('click', function () { self.onSubmitRequest(); });
		btnBack.addEventListener('click', function () { self.closeContact(); });
		this.btnSend = btnSend;
		body.appendChild(el('div', { 'class': 'ssk-actions' }, [btnSend, btnBack]));

		return el('div', { 'class': 'ssk-section ssk-contact', 'data-section': '__contact__', hidden: true }, [
			el('h3', { 'class': 'ssk-section__title', text: this.s.contactHeading || 'Kontaktdaten' }),
			body
		]);
	};

	Configurator.prototype.onRequestOpen = function () {
		if (!this.validateConfig(true)) { return; }
		this.contactBlock.hidden = false;
		this.contactBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
	};

	Configurator.prototype.closeContact = function () {
		this.contactBlock.hidden = true;
		this.clearMessage();
	};

	/* --------------------------- Reaktivität ---------------------------- */

	Configurator.prototype.onChange = function () {
		this.updateConditionals();
		this.updateAnimations();
		this.renderSummary();
	};

	Configurator.prototype.updateConditionals = function () {
		var self = this;
		(this.data.schema || []).forEach(function (section) {
			if (section.type === 'repeater') {
				self.repeaters[section.id].items.forEach(function (entry) {
					self.applyConditionals(section.fields, entry.refs);
				});
			} else {
				self.applyConditionals(section.fields, self.groupRefs[section.id]);
			}
		});
	};

	Configurator.prototype.applyConditionals = function (fields, refs) {
		fields.forEach(function (def) {
			var ref = refs[def.id];
			if (!ref) { return; }

			// allow_other: Freitextfeld ein-/ausblenden.
			if (def.allowOther && ref.otherInput) {
				ref.otherInput.style.display = (ref.input.value === OTHER) ? '' : 'none';
			}

			// show_if: Feld ein-/ausblenden.
			if (def.showIf) {
				var ctrl = refs[def.showIf.field];
				var actual = ctrl ? (ctrl.def.type === 'checkbox' ? (ctrl.input.checked ? '1' : '') : ctrl.input.value) : '';
				var expect = def.showIf.value;
				var match = Array.isArray(expect) ? expect.indexOf(actual) >= 0 : String(actual) === String(expect);
				ref.wrapper.style.display = match ? '' : 'none';
			}
		});
	};

	Configurator.prototype.isFieldVisible = function (ref) {
		return ref.wrapper.style.display !== 'none';
	};

	/* -------------------------- Anzeigewerte ---------------------------- */

	Configurator.prototype.resolveDisplay = function (def, ref) {
		var v = def.type === 'checkbox' ? ref.input.checked : String(ref.input.value).trim();
		if (def.type === 'checkbox') {
			return v ? (this.lang === 'en' ? 'Yes' : 'Ja') : '';
		}
		if (v === '') { return ''; }
		if (def.type === 'select') {
			if (def.allowOther && v === OTHER) { return ref.getOther(); }
			var found = '';
			(def.options || []).forEach(function (o) { if (String(o.value) === v) { found = o.label; } });
			return found || v;
		}
		if (def.type === 'number') {
			return def.unit ? (v + ' ' + def.unit) : v;
		}
		return v;
	};

	Configurator.prototype.renderSummary = function () {
		var self = this;
		this.summaryBody.innerHTML = '';

		(this.data.schema || []).forEach(function (section) {
			var rows = [];
			if (section.type === 'repeater') {
				var rep = self.repeaters[section.id];
				rep.items.forEach(function (entry, i) {
					section.fields.forEach(function (def) {
						var val = self.resolveDisplay(def, entry.refs[def.id]);
						if (val !== '') {
							rows.push({ label: (section.itemLabel || '') + ' ' + (i + 1) + ' – ' + def.label, value: val });
						}
					});
				});
			} else {
				section.fields.forEach(function (def) {
					var ref = self.groupRefs[section.id][def.id];
					if (!self.isFieldVisible(ref)) { return; }
					var val = self.resolveDisplay(def, ref);
					if (val !== '') { rows.push({ label: def.label, value: val }); }
				});
			}

			if (rows.length) {
				var group = el('div', { 'class': 'ssk-summary__group' }, [el('h4', { text: section.label })]);
				rows.forEach(function (r) {
					group.appendChild(el('div', { 'class': 'ssk-summary__row' }, [
						el('span', { text: r.label }),
						el('span', { text: r.value })
					]));
				});
				self.summaryBody.appendChild(group);
			}
		});
	};

	/* --------------------------- Validierung ---------------------------- */

	Configurator.prototype.buildErrorMap = function () {
		var self = this;
		var map = {};
		(this.data.schema || []).forEach(function (section) {
			if (section.type === 'repeater') {
				self.repeaters[section.id].items.forEach(function (entry, i) {
					section.fields.forEach(function (def) {
						map[section.id + '.' + i + '.' + def.id] = entry.refs[def.id];
					});
				});
			} else {
				section.fields.forEach(function (def) {
					map[section.id + '.' + def.id] = self.groupRefs[section.id][def.id];
				});
			}
		});
		Object.keys(this.contactRefs).forEach(function (id) {
			map['contact.' + id] = self.contactRefs[id];
		});
		return map;
	};

	Configurator.prototype.clearAllErrors = function () {
		var nodes = this.root.querySelectorAll('.ssk-has-error');
		Array.prototype.forEach.call(nodes, function (n) { n.classList.remove('ssk-has-error'); });
	};

	Configurator.prototype.setError = function (wrapper, message) {
		if (!wrapper) { return; }
		wrapper.classList.add('ssk-has-error');
		var errEl = wrapper.querySelector('.ssk-field__error');
		if (errEl && message) { errEl.textContent = message; }
	};

	Configurator.prototype.collectConfigErrors = function () {
		var self = this;
		var keys = [];

		(this.data.schema || []).forEach(function (section) {
			if (section.type === 'repeater') {
				self.repeaters[section.id].items.forEach(function (entry, i) {
					section.fields.forEach(function (def) {
						self.checkField(def, entry.refs[def.id], section.id + '.' + i + '.' + def.id, keys, entry.refs);
					});
				});
			} else {
				var refs = self.groupRefs[section.id];
				section.fields.forEach(function (def) {
					var ref = refs[def.id];
					if (!self.isFieldVisible(ref)) { return; }
					self.checkField(def, ref, section.id + '.' + def.id, keys, refs);
				});
			}
		});

		return keys;
	};

	Configurator.prototype.checkField = function (def, ref, key, keys) {
		if (def.type === 'checkbox') { return; }
		var v = String(ref.input.value).trim();
		if (def.allowOther && v === OTHER) { v = ref.getOther(); }

		if (def.required && v === '') { keys.push(key); return; }

		if (def.type === 'number' && v !== '') {
			if (!isNumeric(v)) { keys.push(key); return; }
			var num = parseFloat(v.replace(',', '.'));
			if (def.min != null && num < parseFloat(def.min)) { keys.push(key); }
		}
	};

	Configurator.prototype.validateConfig = function (showMessage) {
		this.clearAllErrors();
		var keys = this.collectConfigErrors();
		if (keys.length) {
			this.applyErrorKeys(keys);
			if (showMessage) { this.showError(this.s.fixErrors || 'Bitte Felder korrigieren.'); }
			this.scrollToFirstError();
			return false;
		}
		this.clearMessage();
		return true;
	};

	Configurator.prototype.collectContactErrors = function () {
		var keys = [];
		var name = this.contactRefs.name ? String(this.contactRefs.name.input.value).trim() : '';
		if (name === '') { keys.push('contact.name'); }

		var email = this.contactRefs.email ? String(this.contactRefs.email.input.value).trim() : '';
		if (email === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { keys.push('contact.email'); }

		if (!this.privacyInput.checked) { keys.push('contact.datenschutz'); }

		if (this.fileInput && this.fileInput.files && this.fileInput.files[0]) {
			var max = this.data.upload && this.data.upload.maxSize ? this.data.upload.maxSize : 0;
			if (max > 0 && this.fileInput.files[0].size > max) { keys.push('contact.upload'); }
		}
		return keys;
	};

	Configurator.prototype.applyErrorKeys = function (keys) {
		var map = this.buildErrorMap();
		var self = this;
		keys.forEach(function (k) {
			if (k === 'contact.datenschutz') { self.setError(self.privacyWrap, self.s.privacyRequired); return; }
			if (k === 'contact.upload') { self.setError(self.uploadWrap, self.s.fileTooLarge); return; }
			var ref = map[k];
			if (ref) {
				var msg = self.s.fieldRequired;
				if (k === 'contact.email') { msg = self.s.emailInvalid; }
				self.setError(ref.wrapper, msg);
			}
		});
	};

	Configurator.prototype.scrollToFirstError = function () {
		var first = this.root.querySelector('.ssk-has-error');
		if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
	};

	/* ----------------------------- Payload ------------------------------ */

	Configurator.prototype.collectConfig = function () {
		var self = this;
		var config = {};
		(this.data.schema || []).forEach(function (section) {
			if (section.type === 'repeater') {
				config[section.id] = self.repeaters[section.id].items.map(function (entry) {
					var item = {};
					section.fields.forEach(function (def) {
						var ref = entry.refs[def.id];
						item[def.id] = def.type === 'checkbox' ? (ref.input.checked ? '1' : '') : ref.input.value;
						if (def.allowOther) { item[def.id + '_other'] = ref.getOther(); }
					});
					return item;
				});
			} else {
				var obj = {};
				var refs = self.groupRefs[section.id];
				section.fields.forEach(function (def) {
					var ref = refs[def.id];
					obj[def.id] = def.type === 'checkbox' ? (ref.input.checked ? '1' : '') : ref.input.value;
					if (def.allowOther) { obj[def.id + '_other'] = ref.getOther(); }
				});
				config[section.id] = obj;
			}
		});
		return config;
	};

	Configurator.prototype.collectContact = function () {
		var c = {};
		Object.keys(this.contactRefs).forEach(function (id) {
			c[id] = this.contactRefs[id].input.value;
		}, this);
		return c;
	};

	/* ----------------------------- Aktionen ----------------------------- */

	Configurator.prototype.onDownload = function () {
		if (!this.validateConfig(true)) { return; }
		var payload = {
			config: this.collectConfig(),
			language: this.lang,
			hp: this.honeypot.value,
			ts: this.renderTs
		};
		this.send(this.data.restPdf, payload, this.btnDownload, this.s.generating, false);
	};

	Configurator.prototype.onSubmitRequest = function () {
		var self = this;
		var ok = this.validateConfig(false);
		var contactKeys = this.collectContactErrors();
		if (!ok || contactKeys.length) {
			this.clearAllErrors();
			var keys = this.collectConfigErrors().concat(contactKeys);
			this.applyErrorKeys(keys);
			this.showError(this.s.fixErrors || 'Bitte Felder korrigieren.');
			this.scrollToFirstError();
			return;
		}

		var build = Promise.resolve(null);
		if (this.fileInput && this.fileInput.files && this.fileInput.files[0]) {
			var file = this.fileInput.files[0];
			build = readFileAsBase64(file).then(function (b64) {
				return { name: file.name, type: file.type, data: b64 };
			});
		}

		build.then(function (upload) {
			var payload = {
				config: self.collectConfig(),
				contact: self.collectContact(),
				datenschutz: self.privacyInput.checked ? '1' : '',
				language: self.lang,
				hp: self.honeypot.value,
				ts: self.renderTs
			};
			if (upload) { payload.upload = upload; }
			self.send(self.data.restAnfrage, payload, self.btnSend, self.s.sending, true);
		}).catch(function () {
			self.showError(self.s.genericError || 'Fehler.');
		});
	};

	Configurator.prototype.send = function (url, payload, button, busyText, isRequest) {
		var self = this;
		this.clearMessage();
		var original = button.innerHTML;
		button.disabled = true;
		button.innerHTML = '';
		button.appendChild(el('span', { 'class': 'ssk-spinner' }));
		button.appendChild(document.createTextNode(' ' + (busyText || '…')));

		fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': this.data.nonce },
			body: JSON.stringify(payload)
		}).then(function (res) {
			return res.json().then(function (json) { return { status: res.status, json: json }; });
		}).then(function (r) {
			button.disabled = false;
			button.innerHTML = original;

			if (!r.json || !r.json.ok) {
				self.clearAllErrors();
				if (r.json && r.json.fields) {
					self.applyErrorKeys(Object.keys(r.json.fields));
				}
				self.showError((r.json && r.json.message) ? r.json.message : (self.s.genericError || 'Fehler.'));
				self.scrollToFirstError();
				return;
			}

			self.lastPdf = { data: r.json.pdf, filename: r.json.filename };
			downloadBase64Pdf(r.json.pdf, r.json.filename);

			if (isRequest) {
				self.contactBlock.hidden = true;
				self.showSuccess(self.s.requestSuccess || 'Gesendet.');
			} else {
				self.showSuccess(self.s.downloadReady || 'PDF erstellt.');
			}
		}).catch(function () {
			button.disabled = false;
			button.innerHTML = original;
			self.showError(self.s.genericError || 'Fehler.');
		});
	};

	/* ----------------------------- Meldungen ---------------------------- */

	Configurator.prototype.clearMessage = function () {
		this.messageBox.innerHTML = '';
	};

	Configurator.prototype.showError = function (text) {
		this.messageBox.innerHTML = '';
		this.messageBox.appendChild(el('div', { 'class': 'ssk-message ssk-message--error', text: text }));
	};

	Configurator.prototype.showSuccess = function (text) {
		var self = this;
		this.messageBox.innerHTML = '';
		var box = el('div', { 'class': 'ssk-message ssk-message--success' }, [el('span', { text: text + ' ' })]);
		if (this.lastPdf) {
			var link = el('a', { href: '#', text: this.s.downloadPdf || 'PDF herunterladen' });
			link.addEventListener('click', function (e) {
				e.preventDefault();
				downloadBase64Pdf(self.lastPdf.data, self.lastPdf.filename);
			});
			box.appendChild(link);
		}
		this.messageBox.appendChild(box);
	};

	/* ------------------------------- Init ------------------------------- */

	function init() {
		var roots = document.querySelectorAll('.ssk-konfigurator[data-ssk]');
		Array.prototype.forEach.call(roots, function (root) {
			if (root.getAttribute('data-ssk-init')) { return; }
			root.setAttribute('data-ssk-init', '1');
			try {
				new Configurator(root, window.SSK_DATA);
			} catch (e) {
				if (window.console) { console.error('SSK Konfigurator:', e); }
			}
		});
	}

	if (document.readyState !== 'loading') { init(); }
	else { document.addEventListener('DOMContentLoaded', init); }
})();
