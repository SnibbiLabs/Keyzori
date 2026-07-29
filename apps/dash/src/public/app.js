const state = {
	view: "keys",
	keys: [],
	users: [],
	search: "",
	status: "all",
	revealedKeys: new Map(),
	editing: null,
	confirmAction: null,
};

const $ = (selector) => document.querySelector(selector);
const loginScreen = $("#login-screen");
const appShell = $("#app-shell");
const editorDialog = $("#editor-dialog");
const confirmDialog = $("#confirm-dialog");
const secretDialog = $("#secret-dialog");
let toastTimer;

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = String(text);
	return node;
}

function showToast(message, error = false) {
	const toast = $("#toast");
	toast.textContent = message;
	toast.className = `toast visible${error ? " error" : ""}`;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toast.className = "toast";
	}, 3200);
}

async function api(path, options = {}) {
	const headers = { accept: "application/json", ...(options.headers || {}) };
	if (options.body !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(path, {
		...options,
		headers,
		credentials: "same-origin",
		body:
			options.body === undefined || typeof options.body === "string"
				? options.body
				: JSON.stringify(options.body),
	});
	let payload = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	if (response.status === 401 && path !== "/api/login") {
		showLogin();
		throw new Error("Your session expired. Sign in again.");
	}
	if (!response.ok) {
		throw new Error(payload?.error || `Request failed (${response.status})`);
	}
	return payload;
}

function showLogin() {
	state.revealedKeys.clear();
	appShell.classList.add("hidden");
	loginScreen.classList.remove("hidden");
	setTimeout(() => $("#password").focus(), 0);
}

function showApp() {
	loginScreen.classList.add("hidden");
	appShell.classList.remove("hidden");
	render();
}

function formatDate(value, includeTime = false) {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		...(includeTime ? { timeStyle: "short" } : {}),
	}).format(date);
}

function dateTimeLocal(value) {
	if (!value) return "";
	const date = new Date(value);
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function userFor(id) {
	return state.users.find((user) => user.id === id);
}

function filteredRecords() {
	const query = state.search.trim().toLowerCase();
	const records = state.view === "keys" ? state.keys : state.users;
	return records.filter((record) => {
		if (
			state.view === "keys" &&
			state.status !== "all" &&
			(state.status === "revoked") !== record.revoked
		) {
			return false;
		}
		if (!query) return true;
		const owner = state.view === "keys" ? userFor(record.userId) : null;
		return [...Object.values(record), owner?.name, owner?.email]
			.filter((value) => value !== null && value !== undefined)
			.some((value) =>
				(typeof value === "object" ? JSON.stringify(value) : String(value))
					.toLowerCase()
					.includes(query),
			);
	});
}

function actionButton(label, action, danger = false) {
	const button = element(
		"button",
		`row-action${danger ? " delete" : ""}`,
		label,
	);
	button.type = "button";
	button.addEventListener("click", action);
	return button;
}

async function copyToClipboard(value, successMessage) {
	try {
		await navigator.clipboard.writeText(value);
		showToast(successMessage);
	} catch {
		showToast("Could not access the clipboard. Copy the value manually.", true);
	}
}

function licenseSecretCell(key) {
	const secret = state.revealedKeys.get(key.id);
	if (!secret) {
		const masked = element("span", "key-secret-masked", key.key);
		masked.title =
			"The full secret is only available when the license is created.";
		return masked;
	}

	const button = element("button", "key-secret");
	button.type = "button";
	button.title = "Hover to reveal. Click to copy.";
	button.setAttribute("aria-label", "Copy full license key");
	button.append(element("code", "key-secret-value", secret));
	button.append(element("span", "key-secret-copy", "Copy"));
	button.addEventListener("click", () =>
		copyToClipboard(secret, "License key copied"),
	);
	return button;
}

function metric(label, value) {
	const item = element("div", "metric");
	item.append(element("span", "", label));
	item.append(element("strong", "", value));
	return item;
}

function recordActions(...buttons) {
	const actions = element("div", "row-actions");
	actions.append(...buttons.filter(Boolean));
	return actions;
}

function initials(name) {
	return String(name || "K")
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => part[0])
		.join("")
		.toUpperCase();
}

function renderKeys(records) {
	const cards = records.map((key) => {
		const card = element("article", "record-card");
		card.dataset.id = key.id;
		const header = element("header", "record-card-header");
		const identity = element("div", "record-identity");
		identity.append(element("span", "record-avatar", "K"));
		const title = element("div", "record-title");
		const owner = userFor(key.userId);
		title.append(element("strong", "", owner?.name || "Unknown owner"));
		title.append(element("span", "", owner?.email || key.userId));
		identity.append(title);
		const badges = element("div", "badge-row");
		badges.append(
			element("span", "type-badge", key.type),
			element(
				"span",
				`status-badge${key.revoked ? " revoked" : ""}`,
				key.revoked ? "Revoked" : "Active",
			),
		);
		header.append(identity, badges);

		const limits = element("div", "record-metrics");
		limits.append(
			metric("Device limit", key.limitHwid || "Unlimited"),
			metric("IP limit", key.limitIp || "Unlimited"),
			metric("Concurrent", key.limitConcurrent || "Unlimited"),
		);

		const footer = element("footer", "record-card-footer");
		const expiry = key.expiresAt
			? `Expires ${formatDate(key.expiresAt)}`
			: `Created ${formatDate(key.createdAt)}`;
		footer.append(element("span", "", expiry));
		footer.append(
			recordActions(
				actionButton("Edit", () => openKeyEditor(key)),
				!key.revoked ? actionButton("Revoke", () => confirmRevoke(key)) : null,
				actionButton("Delete", () => confirmDeleteKey(key), true),
			),
		);

		card.append(header, licenseSecretCell(key), limits, footer);
		return card;
	});
	$("#records-grid").replaceChildren(...cards);
}

function renderUsers(records) {
	const cards = records.map((user) => {
		const card = element("article", "record-card");
		card.dataset.id = user.id;
		const header = element("header", "record-card-header");
		const identity = element("div", "record-identity");
		identity.append(element("span", "record-avatar", initials(user.name)));
		const title = element("div", "record-title");
		title.append(element("strong", "", user.name));
		title.append(element("span", "", user.email));
		identity.append(title);
		const licenseCount = state.keys.filter(
			(key) => key.userId === user.id,
		).length;
		const badge = element(
			"span",
			"type-badge",
			`${licenseCount} license${licenseCount === 1 ? "" : "s"}`,
		);
		header.append(identity, badge);

		const metadata = element("div", "metadata-preview");
		const customFields = Object.entries(user.customFields || {});
		if (customFields.length) {
			for (const [key, value] of customFields.slice(0, 3)) {
				metadata.append(
					element("span", "meta-chip", `${key}: ${String(value)}`),
				);
			}
			if (customFields.length > 3) {
				metadata.append(
					element("span", "meta-chip", `+${customFields.length - 3} more`),
				);
			}
		} else {
			metadata.append(element("span", "empty-metadata", "No custom fields"));
		}

		const details = element("div", "record-metrics");
		details.append(
			metric("Licenses", licenseCount),
			metric("Custom fields", customFields.length),
			metric("Created", formatDate(user.createdAt)),
		);

		const footer = element("footer", "record-card-footer");
		footer.append(element("span", "", `ID ${user.id}`));
		footer.append(
			recordActions(
				actionButton("Edit", () => openUserEditor(user)),
				actionButton("Delete", () => confirmDeleteUser(user), true),
			),
		);

		card.append(header, metadata, details, footer);
		return card;
	});
	$("#records-grid").replaceChildren(...cards);
}

function render() {
	const records = filteredRecords();
	const isKeys = state.view === "keys";
	const activeKeys = state.keys.filter((key) => !key.revoked).length;
	$("#view-title").textContent = isKeys ? "License keys" : "Customers";
	$("#view-description").textContent = isKeys
		? "Manage access issued by this server"
		: "Manage customer records and license ownership";
	$("#add-button").textContent = isKeys ? "+ Add license" : "+ Add customer";
	$("#records-title").textContent = isKeys ? "All licenses" : "All customers";
	$("#records-count").textContent =
		`${records.length} record${records.length === 1 ? "" : "s"}`;
	$("#status-filter-wrap").classList.toggle("hidden", !isKeys);
	$("#summary-primary-label").textContent = isKeys
		? "Total licenses"
		: "Total customers";
	$("#summary-primary").textContent = String(
		isKeys ? state.keys.length : state.users.length,
	);
	$("#summary-primary-copy").textContent = isKeys
		? "Issued by this server"
		: "Managed accounts";
	$("#summary-secondary-label").textContent = isKeys
		? "Active licenses"
		: "Licensed customers";
	$("#summary-secondary").textContent = String(
		isKeys
			? activeKeys
			: state.users.filter((user) =>
					state.keys.some((key) => key.userId === user.id),
				).length,
	);
	$("#summary-secondary-copy").textContent = isKeys
		? "Ready to validate"
		: "With at least one license";
	$("#summary-tertiary-label").textContent = isKeys
		? "Customers"
		: "Total licenses";
	$("#summary-tertiary").textContent = String(
		isKeys ? state.users.length : state.keys.length,
	);
	$("#summary-tertiary-copy").textContent = isKeys
		? "License owners"
		: "Across all customers";
	for (const button of document.querySelectorAll(".nav-item")) {
		button.classList.toggle("active", button.dataset.view === state.view);
		button.setAttribute(
			"aria-current",
			button.dataset.view === state.view ? "page" : "false",
		);
	}
	if (isKeys) renderKeys(records);
	else renderUsers(records);
	$("#empty-state").classList.toggle("hidden", records.length !== 0);
	$("#empty-title").textContent = state.search
		? "No matching records"
		: isKeys
			? "No licenses yet"
			: "No customers yet";
	$("#empty-copy").textContent = state.search
		? "Try a different search or filter."
		: `Add ${isKeys ? "a license" : "a customer"} to get started.`;
	$("#keys-count").textContent = String(state.keys.length);
	$("#users-count").textContent = String(state.users.length);
}

async function refresh(silent = false) {
	const button = $("#refresh-button");
	button.disabled = true;
	try {
		const [users, keys] = await Promise.all([
			api("/api/admin/users"),
			api("/api/admin/keys"),
		]);
		state.users = users;
		state.keys = keys;
		$("#server-dot").classList.add("online");
		render();
		if (!silent) showToast("Records refreshed");
	} catch (error) {
		$("#server-dot").classList.remove("online");
		showToast(error.message, true);
	} finally {
		button.disabled = false;
	}
}

function customFieldInputValue(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function addCustomFieldRow(list, key = "", value = "") {
	const row = element("div", "custom-field-row");
	const keyInput = element("input", "custom-field-key");
	keyInput.type = "text";
	keyInput.placeholder = "KEY";
	keyInput.value = key;
	keyInput.maxLength = 200;
	keyInput.setAttribute("aria-label", "Custom field key");

	const valueInput = element("input", "custom-field-value");
	valueInput.type = "text";
	valueInput.placeholder = "VALUE";
	valueInput.value = customFieldInputValue(value);
	valueInput.setAttribute("aria-label", "Custom field value");

	const remove = element("button", "custom-field-remove", "×");
	remove.type = "button";
	remove.title = "Remove field";
	remove.setAttribute("aria-label", "Remove custom field");
	remove.addEventListener("click", () => {
		row.remove();
		if (!list.children.length)
			addCustomFieldRow(list).querySelector("input")?.focus();
	});

	row.append(keyInput, valueInput, remove);
	list.append(row);
	return row;
}

function setupCustomFieldsEditor(editor, customFields = {}) {
	const list = element("div", "custom-field-list");
	const entries = Object.entries(customFields);
	if (entries.length) {
		for (const [key, value] of entries) addCustomFieldRow(list, key, value);
	} else {
		addCustomFieldRow(list);
	}

	const add = element("button", "button custom-field-add", "+ Add field");
	add.type = "button";
	add.addEventListener("click", () => {
		addCustomFieldRow(list).querySelector("input")?.focus();
	});
	editor.replaceChildren(list, add);
}

function readCustomFields(form) {
	const result = {};
	for (const row of form.querySelectorAll(".custom-field-row")) {
		const key = row.querySelector(".custom-field-key").value.trim();
		const rawValue = row.querySelector(".custom-field-value").value.trim();
		if (!key && !rawValue) continue;
		if (!key) throw new Error("Every custom field needs a key.");
		if (Object.hasOwn(result, key)) {
			throw new Error(`Custom field keys must be unique: ${key}`);
		}
		try {
			result[key] = JSON.parse(rawValue);
		} catch {
			result[key] = rawValue;
		}
	}
	return result;
}

function userFields(user) {
	const fields = $("#editor-fields");
	fields.innerHTML = `
		<div class="field">
			<label for="owner-name">Name</label>
			<input id="owner-name" name="name" maxlength="200" required />
		</div>
		<div class="field">
			<label for="owner-email">Email</label>
			<input id="owner-email" name="email" type="email" maxlength="254" required />
		</div>
		<div class="field">
			<label id="owner-custom-fields-label">Custom fields</label>
			<div class="custom-fields-editor" data-custom-fields aria-labelledby="owner-custom-fields-label"></div>
			<span class="field-hint">Add customer metadata such as company, account ID, or internal notes. JSON values are supported.</span>
		</div>
	`;
	setupCustomFieldsEditor(
		fields.querySelector("[data-custom-fields]"),
		user?.customFields || {},
	);
	if (user) {
		fields.querySelector("[name=name]").value = user.name;
		fields.querySelector("[name=email]").value = user.email;
	}
}

function keyFields(key) {
	const fields = $("#editor-fields");
	fields.innerHTML = `
		<div class="field full">
			<label for="key-owner">Owner</label>
			<select id="key-owner" name="userId" required></select>
		</div>
		<div class="field-grid">
			<div class="field">
				<label for="key-type">License type</label>
				<select id="key-type" name="type" required>
					<option value="PERPETUAL">Perpetual</option>
					<option value="SUBSCRIPTION">Subscription</option>
					<option value="USAGE">Usage</option>
				</select>
			</div>
			<div class="field">
				<label for="key-expiry">Expires at</label>
				<input id="key-expiry" name="expiresAt" type="datetime-local" />
			</div>
			<div class="field">
				<label for="limit-hwid">HWID limit</label>
				<input id="limit-hwid" name="limitHwid" type="number" min="0" max="2147483647" step="1" value="0" required />
			</div>
			<div class="field">
				<label for="limit-ip">IP limit</label>
				<input id="limit-ip" name="limitIp" type="number" min="0" max="2147483647" step="1" value="0" required />
			</div>
			<div class="field">
				<label for="limit-concurrent">Concurrent limit</label>
				<input id="limit-concurrent" name="limitConcurrent" type="number" min="0" max="2147483647" step="1" value="0" required />
			</div>
			<div class="field">
				<label for="limit-usage">Usage balance</label>
				<input id="limit-usage" name="limitUsage" type="number" min="0" max="2147483647" step="1" value="0" required />
			</div>
			<div class="field">
				<label for="trial-duration">Trial minutes</label>
				<input id="trial-duration" name="trialDurationMin" type="number" min="0" max="2147483647" step="1" value="0" required />
			</div>
		</div>
		<div class="field full">
			<label id="key-custom-fields-label">Custom fields</label>
			<div class="custom-fields-editor" data-custom-fields aria-labelledby="key-custom-fields-label"></div>
			<span class="field-hint">Add metadata returned after successful validation. JSON values are supported; do not store secrets.</span>
		</div>
		<div class="checkbox-field${key ? "" : " hidden"}">
			<input id="key-revoked" name="revoked" type="checkbox" />
			<label for="key-revoked">Reject future handshakes</label>
		</div>
	`;
	setupCustomFieldsEditor(
		fields.querySelector("[data-custom-fields]"),
		key?.customFields || {},
	);
	const ownerSelect = fields.querySelector("[name=userId]");
	for (const user of state.users) {
		const option = element("option", "", `${user.name} — ${user.email}`);
		option.value = user.id;
		ownerSelect.append(option);
	}
	if (key) {
		ownerSelect.value = key.userId;
		fields.querySelector("[name=type]").value = key.type;
		for (const name of [
			"limitHwid",
			"limitIp",
			"limitConcurrent",
			"limitUsage",
			"trialDurationMin",
		]) {
			fields.querySelector(`[name=${name}]`).value = String(key[name]);
		}
		fields.querySelector("[name=expiresAt]").value = dateTimeLocal(
			key.expiresAt,
		);
		fields.querySelector("[name=revoked]").checked = key.revoked;
	}
	const type = fields.querySelector("[name=type]");
	const syncTypeFields = () => {
		const subscription = type.value === "SUBSCRIPTION";
		const usage = type.value === "USAGE";
		fields.querySelector("[name=expiresAt]").required = subscription;
		fields.querySelector("[name=limitUsage]").min = usage ? "1" : "0";
	};
	type.addEventListener("change", syncTypeFields);
	syncTypeFields();
}

function openUserEditor(user = null) {
	state.editing = { kind: "user", record: user };
	$("#editor-eyebrow").textContent = user ? "EDIT CUSTOMER" : "NEW CUSTOMER";
	$("#editor-title").textContent = user ? "Edit customer" : "Add customer";
	$("#editor-submit").textContent = user ? "Save changes" : "Create customer";
	$("#editor-error").textContent = "";
	userFields(user);
	editorDialog.showModal();
}

function openKeyEditor(key = null) {
	if (!state.users.length) {
		showToast("Create a customer before adding a license.", true);
		state.view = "users";
		render();
		return;
	}
	state.editing = { kind: "key", record: key };
	$("#editor-eyebrow").textContent = key ? "EDIT LICENSE" : "NEW LICENSE";
	$("#editor-title").textContent = key ? "Edit license" : "Add license";
	$("#editor-submit").textContent = key ? "Save changes" : "Create license";
	$("#editor-error").textContent = "";
	keyFields(key);
	editorDialog.showModal();
}

function readKeyPayload(form, editing) {
	const data = new FormData(form);
	const type = data.get("type");
	const expiry = data.get("expiresAt");
	const payload = {
		userId: data.get("userId"),
		type,
		limitIp: Number(data.get("limitIp")),
		limitHwid: Number(data.get("limitHwid")),
		limitConcurrent: Number(data.get("limitConcurrent")),
		limitUsage: Number(data.get("limitUsage")),
		trialDurationMin: Number(data.get("trialDurationMin")),
		customFields: readCustomFields(form),
	};
	if (type === "SUBSCRIPTION" && expiry) {
		payload.expiresAt = new Date(expiry).toISOString();
	} else if (editing) {
		payload.expiresAt = null;
	}
	if (editing) payload.revoked = data.get("revoked") === "on";
	return payload;
}

function openConfirmation(
	title,
	copy,
	action,
	actionLabel = "Delete permanently",
) {
	state.confirmAction = action;
	$("#confirm-title").textContent = title;
	$("#confirm-copy").textContent = copy;
	$("#confirm-submit").textContent = actionLabel;
	confirmDialog.showModal();
}

function confirmDeleteUser(user) {
	const count = state.keys.filter((key) => key.userId === user.id).length;
	openConfirmation(
		`Delete ${user.name}?`,
		`This permanently deletes the customer and ${count} associated license${count === 1 ? "" : "s"}. This cannot be undone.`,
		async () => {
			await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
				method: "DELETE",
			});
			for (const key of state.keys) {
				if (key.userId === user.id) state.revealedKeys.delete(key.id);
			}
			showToast("Customer deleted");
		},
	);
}

function confirmDeleteKey(key) {
	openConfirmation(
		"Delete this license?",
		`This permanently deletes ${key.key}. Existing clients will stop validating and the record cannot be restored.`,
		async () => {
			await api(`/api/admin/keys/${encodeURIComponent(key.id)}`, {
				method: "DELETE",
			});
			state.revealedKeys.delete(key.id);
			showToast("License deleted");
		},
	);
}

function confirmRevoke(key) {
	openConfirmation(
		"Revoke this license?",
		`${key.key} will reject future handshakes. You can restore it later from Edit.`,
		async () => {
			await api(`/api/admin/keys/${encodeURIComponent(key.id)}/revoke`, {
				method: "PATCH",
			});
			showToast("License revoked");
		},
		"Revoke license",
	);
}

$("#login-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const submit = event.currentTarget.querySelector("button[type=submit]");
	submit.disabled = true;
	$("#login-error").textContent = "";
	try {
		await api("/api/login", {
			method: "POST",
			body: { password: $("#password").value },
		});
		$("#password").value = "";
		const session = await api("/api/session");
		$("#server-host").textContent = session.server || "Connected";
		showApp();
		await refresh(true);
	} catch (error) {
		$("#login-error").textContent = error.message;
	} finally {
		submit.disabled = false;
	}
});

$("#logout-button").addEventListener("click", async () => {
	try {
		await api("/api/logout", { method: "POST", body: {} });
	} catch (error) {
		showToast(error.message, true);
	} finally {
		showLogin();
	}
});

for (const button of document.querySelectorAll(".nav-item")) {
	button.addEventListener("click", () => {
		state.view = button.dataset.view;
		render();
	});
}

$("#search").addEventListener("input", (event) => {
	state.search = event.target.value;
	render();
});

const statusFilter = $("#status-filter");
const statusFilterMenu = $("#status-filter-menu");
const statusOptions = [...document.querySelectorAll(".custom-select-option")];

function setStatusMenu(open) {
	statusFilter.setAttribute("aria-expanded", String(open));
	statusFilterMenu.classList.toggle("hidden", !open);
}

function selectStatus(option) {
	state.status = option.dataset.value;
	$("#status-filter-label").textContent = option.textContent;
	for (const candidate of statusOptions) {
		candidate.setAttribute("aria-selected", String(candidate === option));
	}
	setStatusMenu(false);
	render();
}

statusFilter.addEventListener("click", () => {
	const opening = statusFilter.getAttribute("aria-expanded") !== "true";
	setStatusMenu(opening);
	if (opening) {
		statusOptions
			.find((option) => option.dataset.value === state.status)
			?.focus();
	}
});

for (const option of statusOptions) {
	option.addEventListener("click", () => selectStatus(option));
	option.addEventListener("keydown", (event) => {
		const current = statusOptions.indexOf(option);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			statusOptions[
				(current + direction + statusOptions.length) % statusOptions.length
			].focus();
		} else if (event.key === "Escape") {
			event.preventDefault();
			setStatusMenu(false);
			statusFilter.focus();
		}
	});
}

document.addEventListener("click", (event) => {
	if (!event.target.closest(".custom-select")) setStatusMenu(false);
});

$("#add-button").addEventListener("click", () => {
	if (state.view === "keys") openKeyEditor();
	else openUserEditor();
});

$("#refresh-button").addEventListener("click", () => refresh());

$("#editor-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const submit = $("#editor-submit");
	submit.disabled = true;
	$("#editor-error").textContent = "";
	try {
		const { kind, record } = state.editing;
		if (kind === "user") {
			const data = new FormData(event.currentTarget);
			const payload = {
				name: data.get("name"),
				email: data.get("email"),
				customFields: readCustomFields(event.currentTarget),
			};
			await api(
				record
					? `/api/admin/users/${encodeURIComponent(record.id)}`
					: "/api/admin/users",
				{ method: record ? "PATCH" : "POST", body: payload },
			);
			showToast(record ? "Customer updated" : "Customer created");
		} else {
			const payload = readKeyPayload(event.currentTarget, Boolean(record));
			const created = await api(
				record
					? `/api/admin/keys/${encodeURIComponent(record.id)}`
					: "/api/admin/keys",
				{ method: record ? "PUT" : "POST", body: payload },
			);
			showToast(record ? "License updated" : "License created");
			if (!record && created.key) {
				state.revealedKeys.set(created.id, created.key);
				$("#secret-value").textContent = created.key;
				secretDialog.showModal();
			}
		}
		editorDialog.close();
		await refresh(true);
	} catch (error) {
		$("#editor-error").textContent = error.message;
	} finally {
		submit.disabled = false;
	}
});

$("#confirm-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const submit = $("#confirm-submit");
	submit.disabled = true;
	try {
		await state.confirmAction?.();
		confirmDialog.close();
		await refresh(true);
	} catch (error) {
		showToast(error.message, true);
	} finally {
		submit.disabled = false;
		state.confirmAction = null;
	}
});

$("#copy-secret").addEventListener("click", () => {
	copyToClipboard($("#secret-value").textContent, "Secret copied");
});

for (const button of document.querySelectorAll("[data-close]")) {
	button.addEventListener("click", () => {
		document.getElementById(button.dataset.close).close();
	});
}

for (const dialog of document.querySelectorAll("dialog")) {
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) dialog.close();
	});
}

document.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		if (!appShell.classList.contains("hidden")) $("#search").focus();
	}
});

async function bootstrap() {
	try {
		const session = await api("/api/session");
		$("#server-host").textContent = session.server;
		if (!session.authenticated) {
			showLogin();
			return;
		}
		showApp();
		await refresh(true);
	} catch (error) {
		showLogin();
		$("#login-error").textContent = error.message;
	}
}

bootstrap();
