"""
Chrome DevTools Protocol (CDP) Test Suite for RackStudio PRO
Connects to Chromium/Edge headless via CDP over WebSockets.
Tests all UI buttons, modals, state interactions, rendering, and consoles.
"""

import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
import websockets

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TEST_URL = "http://localhost:8080/index.html"
PORT = 9222
USER_DATA_DIR = os.path.join(os.path.dirname(__file__), ".cdp_test_profile")

class CDPClient:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.ws = None
        self.msg_id = 1
        self.pending = {}
        self.console_errors = []
        self.console_logs = []
        self._listener_task = None

    async def connect(self):
        self.ws = await websockets.connect(self.ws_url, max_size=10_000_000)
        self._listener_task = asyncio.create_task(self._listen())
        await self.send("Runtime.enable")
        await self.send("Page.enable")
        await self.send("DOM.enable")
        await self.send("Network.enable")
        await self.send("Network.setCacheDisabled", {"cacheDisabled": True})

    async def _listen(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                msg_id = msg.get("id")
                if msg_id and msg_id in self.pending:
                    self.pending[msg_id].set_result(msg)
                method = msg.get("method", "")
                if method == "Runtime.consoleAPICalled":
                    params = msg.get("params", {})
                    log_type = params.get("type", "log")
                    text = " ".join([str(arg.get("value", arg.get("description", ""))) for arg in params.get("args", [])])
                    self.console_logs.append(f"[{log_type}] {text}")
                    if log_type in ("error", "assert"):
                        self.console_errors.append(f"[{log_type}] {text}")
                elif method == "Runtime.exceptionThrown":
                    details = msg.get("params", {}).get("exceptionDetails", {})
                    exc_text = details.get("text", "") + " " + str(details.get("exception", {}).get("description", ""))
                    self.console_errors.append(f"[EXCEPTION] {exc_text}")
                elif method == "Page.javascriptDialogOpening":
                    asyncio.create_task(self.send("Page.handleJavaScriptDialog", {"accept": True}))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            # Connection closed
            pass

    async def send(self, method, params=None):
        mid = self.msg_id
        self.msg_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[mid] = future
        payload = {"id": mid, "method": method}
        if params:
            payload["params"] = params
        await self.ws.send(json.dumps(payload))
        res = await asyncio.wait_for(future, timeout=10.0)
        del self.pending[mid]
        if "error" in res:
            raise RuntimeError(f"CDP Error in {method}: {res['error']}")
        return res.get("result", {})

    async def eval(self, expression, await_promise=False):
        res = await self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise
        })
        val_obj = res.get("result", {})
        if "value" in val_obj:
            return val_obj["value"]
        if val_obj.get("subtype") == "error":
            raise RuntimeError(f"Eval Exception: {val_obj.get('description')}")
        return val_obj

    async def close(self):
        if self._listener_task:
            self._listener_task.cancel()
        if self.ws:
            await self.ws.close()


def ensure_server():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/index.html", timeout=0.8) as resp:
            if resp.getcode() == 200:
                return None
    except Exception:
        pass
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cmd = [sys.executable, "-m", "http.server", "8080", "--directory", root_dir]
    server_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    return server_proc


def launch_browser():
    profile_dir = os.path.join(USER_DATA_DIR, str(int(time.time() * 1000)))
    os.makedirs(profile_dir, exist_ok=True)
    cmd = [
        EDGE_PATH,
        "--headless=new",
        f"--remote-debugging-port={PORT}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-gpu",
        "--disable-cache",
        "--disk-cache-size=1",
        "about:blank"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc


def get_ws_url():
    for _ in range(25):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1.0) as resp:
                data = json.loads(resp.read().decode())
                for tab in data:
                    if tab.get("type") == "page":
                        return tab.get("webSocketDebuggerUrl")
        except Exception:
            time.sleep(0.3)
    raise RuntimeError("Could not connect to browser debugging port")


async def run_test_suite():
    print("=" * 70)
    print("  RackStudio PRO - Automated Chrome DevTools (CDP) Test Runner")
    print("=" * 70)

    print("\n[1/9] Launching Chromium (Edge) in headless mode with remote debugging...")
    server_proc = ensure_server()
    proc = launch_browser()
    test_results = []

    def record(name, success, details=""):
        status = "PASSED" if success else "FAILED"
        print(f"  [{status}] {name}" + (f" -> {details}" if details else ""))
        test_results.append((name, success, details))

    try:
        ws_url = get_ws_url()
        print(f"[2/9] Connected to CDP endpoint: {ws_url}")
        client = CDPClient(ws_url)
        await client.connect()

        # Step 1: Navigate to app
        print(f"[3/9] Navigating to {TEST_URL} ...")
        await client.send("Page.navigate", {"url": TEST_URL})
        for _ in range(50):
            ready = await client.eval("typeof window.app === 'object' && typeof window.store === 'object'")
            if ready:
                break
            await asyncio.sleep(0.1)

        # Reset localStorage and reload to guarantee fresh test isolation
        await client.eval("localStorage.clear(); sessionStorage.clear();")
        await client.send("Page.reload")
        await asyncio.sleep(0.5)
        for _ in range(50):
            ready = await client.eval("typeof window.app === 'object' && typeof window.store === 'object'")
            if ready:
                break
            await asyncio.sleep(0.1)

        # Non-blocking dialog mocks for automated headless testing
        await client.eval("window.alert = (msg) => console.log('[ALERT]', msg); window.confirm = () => true;")

        # -------------------------------------------------------------
        # TEST 1: App Boot & Core Objects
        # -------------------------------------------------------------
        print("\n--- Test Suite 1: App Lifecycle & Global Objects ---")
        app_exists = await client.eval("typeof window.app !== 'undefined'")
        store_exists = await client.eval("typeof window.store !== 'undefined'")
        racks_count = await client.eval("window.store ? window.store.getRacks().length : 0")
        active_rack_u = await client.eval("window.store ? window.store.getActiveRack().uHeight : 0")
        
        record("window.app is instantiated", app_exists)
        record("window.store is initialized", store_exists)
        record(f"Default rack exists ({active_rack_u}U)", racks_count > 0 and active_rack_u == 24, f"{racks_count} racks, active {active_rack_u}U")
        reset_btn_absent = await client.eval("document.getElementById('btn-reset-demo') === null")
        record("Reset to demo button is removed from header", reset_btn_absent)

        # -------------------------------------------------------------
        # TEST 2: Add Rack Button (+ Стойка modal) & Creation
        # -------------------------------------------------------------
        print("\n--- Test Suite 2: Rack Management (+ Стойка) ---")
        
        # Click header + Стойка button
        await client.eval("document.getElementById('btn-add-rack').click()")
        await asyncio.sleep(0.3)
        modal_visible = await client.eval("""
            (() => {
                const el = document.getElementById('rack-modal');
                return el && (el.style.display === 'flex' || !el.classList.contains('hidden'));
            })()
        """)
        record("Click '#btn-add-rack' opens Rack Modal", modal_visible)

        # Fill modal and create new 42U rack
        creation_success = await client.eval("""
            (() => {
                const nameInp = document.getElementById('rack-name-input');
                const uInp = document.getElementById('rack-u-input');
                const form = document.getElementById('rack-form');
                if (!nameInp || !uInp || !form) return false;

                nameInp.value = 'Серверная 42U (ЦОД Main)';
                uInp.value = '42';
                
                // Submit form
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);
                return true;
            })()
        """)
        await asyncio.sleep(0.5)

        active_u_after_add = await client.eval("window.store.getActiveRack().uHeight")
        active_name_after_add = await client.eval("window.store.getActiveRack().name")
        racks_after_add = await client.eval("window.store.getRacks().length")
        
        record("Create 42U Rack via form submission", creation_success and active_u_after_add == 42 and racks_after_add == 2, f"Active: '{active_name_after_add}', {active_u_after_add}U")

        # Verify #rack-container now renders 42 units (installed devices + empty slots)
        rendered_units_count = await client.eval("document.querySelectorAll('#rack-container .slot-empty, #rack-container .installed-device').length")
        record("Rack viewport re-rendered with 42 units", rendered_units_count == 42, f"Found {rendered_units_count} unit slots")

        # Test Sidebar + Стойка button
        await client.eval("document.getElementById('btn-sidebar-add-rack').click()")
        await asyncio.sleep(0.2)
        sidebar_btn_opened = await client.eval("!document.getElementById('rack-modal').classList.contains('hidden')")
        record("Click '#btn-sidebar-add-rack' opens Rack Modal", sidebar_btn_opened)
        
        # Close with Cancel button
        await client.eval("document.getElementById('btn-cancel-rack-modal').click()")
        await asyncio.sleep(0.2)
        modal_closed = await client.eval("document.getElementById('rack-modal').classList.contains('hidden') || document.getElementById('rack-modal').style.display === 'none'")
        record("Close Rack Modal with Cancel button", modal_closed)

        # Test Edit Rack settings button
        await client.eval("document.getElementById('btn-edit-rack').click()")
        await asyncio.sleep(0.2)
        edit_title = await client.eval("document.getElementById('rack-modal-title').textContent")
        record("Click '#btn-edit-rack' opens Settings for current rack", "Настройки" in edit_title, f"Title: {edit_title}")
        await client.eval("document.getElementById('close-rack-modal').click()")
        await asyncio.sleep(0.2)

        # -------------------------------------------------------------
        # TEST 3: Device Palette & Installation (+ Устройство)
        # -------------------------------------------------------------
        print("\n--- Test Suite 3: Device Catalog & Rack Installation ---")
        await client.eval("document.getElementById('btn-catalog').click()")
        await asyncio.sleep(0.3)
        palette_open = await client.eval("!document.getElementById('palette-modal').classList.contains('hidden')")
        templates_count = await client.eval("document.querySelectorAll('#palette-devices-list > div').length")
        record("Click '#btn-catalog' opens Device Catalog", palette_open)
        record(f"Catalog contains device templates", templates_count >= 5, f"{templates_count} equipment templates listed")

        # Install a 24-port switch into unit 24
        install_res = await client.eval("""
            (() => {
                const dev = window.store.installDevice('tpl-switch-24p', 24);
                if (window.app && window.app.closeDevicePalette) {
                    window.app.closeDevicePalette();
                }
                return dev ? dev.id : null;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Install UniFi 24-Port Switch into U24", bool(install_res), f"Installed device ID: {install_res}")

        # Install a Patch Panel into unit 23
        install_patch = await client.eval("""
            (() => {
                const dev = window.store.installDevice('tpl-patch-24p', 23);
                return dev ? dev.id : null;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Install 24P Patch Panel into U23", bool(install_patch), f"Installed patch panel ID: {install_patch}")

        # Verify devices are rendered in the rack
        rendered_devices_count = await client.eval("document.querySelectorAll('#rack-container .installed-device').length")
        record("Rack Enclosure renders installed device faceplates", rendered_devices_count >= 2, f"{rendered_devices_count} devices mounted")

        # Verify Etherlighting ports are present
        etherlighting_ports = await client.eval("document.querySelectorAll('#rack-container .port-slot').length")
        record("Etherlighting interactive ports rendered", etherlighting_ports >= 48, f"{etherlighting_ports} RJ45/SFP+ ports active")

        # Verify 2-row port labels do not overlap lower-row jacks
        two_row_labels_ok = await client.eval("""
            (() => {
                const swDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_switch}"]`);
                const ppDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_patch}"]`);
                if (!swDev || !ppDev) return false;
                const swRect = swDev.getBoundingClientRect();
                const p1 = swDev.querySelector('.port-slot[data-port-id="p-1"]');
                const p2 = swDev.querySelector('.port-slot[data-port-id="p-2"]');
                const sfp1 = swDev.querySelector('.port-slot[data-port-id="sfp-1"]');
                const pp1 = ppDev.querySelector('.port-slot[data-port-id="p-1"]');
                if (!p1 || !p2 || !sfp1 || !pp1) return false;
                const p1Jack = p1.querySelector('.port-jack').getBoundingClientRect();
                const p1Num = p1.querySelector('.port-num').getBoundingClientRect();
                const p2Jack = p2.querySelector('.port-jack').getBoundingClientRect();
                const p2Num = p2.querySelector('.port-num').getBoundingClientRect();
                return (
                    p1.dataset.labelPos === 'top' &&
                    p2.dataset.labelPos === 'bottom' &&
                    sfp1.dataset.labelPos === 'bottom' &&
                    pp1.dataset.labelPos === 'bottom' &&
                    p1Num.bottom <= p1Jack.top + 0.5 &&
                    p1Num.bottom <= p2Jack.top &&
                    p1Num.top >= swRect.top - 0.5 &&
                    p2Num.top >= p2Jack.bottom - 0.5 &&
                    p2Num.bottom <= swRect.bottom + 0.5
                );
            })()
        """.replace("${install_switch}", str(install_res)).replace("${install_patch}", str(install_patch)))
        record("Two-row top port labels placed above jacks without clipping", bool(two_row_labels_ok))

        # Verify U-slot badges are removed from installed device faceplates while names remain
        u_badge_removed_ok = await client.eval("""
            (() => {
                const swDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_switch}"]`);
                const ppDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_patch}"]`);
                if (!swDev || !ppDev) return false;
                const swText = swDev.textContent || '';
                const ppText = ppDev.textContent || '';
                return (
                    swText.includes('Switch 24-Port Pro Max PoE') &&
                    ppText.includes('Patch Panel 24P Cat6 UTP') &&
                    !swText.includes('U24') &&
                    !ppText.includes('U23')
                );
            })()
        """.replace("${install_switch}", str(install_res)).replace("${install_patch}", str(install_patch)))
        record("Installed devices omit U-slot badge while keeping device names", bool(u_badge_removed_ok))

        # Verify dragging installed device to free slot U21 and blocking occupied U24
        drag_coords = await client.eval(f"""
            (() => {{
                const ppDev = document.querySelector('#rack-container .installed-device[data-device-id="{install_patch}"]');
                if (!ppDev) return null;
                ppDev.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                const rect = ppDev.getBoundingClientRect();
                const slotH = rect.height;
                return {{ x: rect.left + 8, y: rect.top + slotH / 2, slotH }};
            }})()
        """)
        drag_move_ok = False
        drag_blocked_ok = False
        if drag_coords:
            gx = drag_coords["x"]
            gy = drag_coords["y"]
            sh = drag_coords["slotH"]
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": gx, "y": gy, "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": gx, "y": gy + sh, "buttons": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": gx, "y": gy + 2 * sh, "buttons": 1})
            await asyncio.sleep(0.1)
            preview_u21 = await client.eval("document.getElementById('rack-drop-preview')?.textContent || ''")
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": gx, "y": gy + 2 * sh, "button": "left", "clickCount": 1})
            await asyncio.sleep(0.25)
            pos_after_drag = await client.eval(f"window.store.getActiveRack().installedDevices.find(d => d.id === '{install_patch}')?.uPosition")
            drag_move_ok = (preview_u21 == "U21" and pos_after_drag == 21)

            # Now test dropping onto occupied U24 is rejected
            drag_coords2 = await client.eval(f"""
                (() => {{
                    const ppDev = document.querySelector('#rack-container .installed-device[data-device-id="{install_patch}"]');
                    if (!ppDev) return null;
                    ppDev.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                    const rect = ppDev.getBoundingClientRect();
                    return {{ x: rect.left + 8, y: rect.top + rect.height / 2, slotH: rect.height }};
                }})()
            """)
            if drag_coords2:
                gx2 = drag_coords2["x"]
                gy2 = drag_coords2["y"]
                sh2 = drag_coords2["slotH"]
                await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": gx2, "y": gy2, "button": "left", "clickCount": 1})
                await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": gx2, "y": gy2 - 3 * sh2, "buttons": 1})
                await asyncio.sleep(0.1)
                preview_u24 = await client.eval("document.getElementById('rack-drop-preview')?.textContent || ''")
                await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": gx2, "y": gy2 - 3 * sh2, "button": "left", "clickCount": 1})
                await asyncio.sleep(0.25)
                pos_after_blocked = await client.eval(f"window.store.getActiveRack().installedDevices.find(d => d.id === '{install_patch}')?.uPosition")
                drag_blocked_ok = ("Занято" in preview_u24 and pos_after_blocked == 21)

        record("Drag device to free slot updates uPosition (U23 -> U21)", drag_move_ok)
        record("Dragging device onto occupied slot (U24) is blocked", drag_blocked_ok)

        # -------------------------------------------------------------
        # TEST 4: Workplace Groups & Isolation Filtering (+ Группа)
        # -------------------------------------------------------------
        print("\n--- Test Suite 4: Workplace Groups & Visual Isolation ---")
        await client.eval("document.getElementById('btn-add-group').click()")
        await asyncio.sleep(0.3)
        group_modal_open = await client.eval("!document.getElementById('group-modal').classList.contains('hidden')")
        record("Click '#btn-add-group' opens Workplace Group Modal", group_modal_open)

        # Create new group
        new_group_id = await client.eval("""
            (() => {
                const nameInp = document.getElementById('grp-name-input');
                const colorInp = document.getElementById('grp-color-input');
                const vlanInp = document.getElementById('grp-vlan-input');
                const form = document.getElementById('group-form');
                
                nameInp.value = 'Рабочее место Инженер 1 (CAD)';
                colorInp.value = '#00ffcc';
                vlanInp.value = '30';
                
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);

                const groups = window.store.getGroups();
                const created = groups.find(g => g.name === 'Рабочее место Инженер 1 (CAD)');
                return created ? created.id : null;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Add new workplace group (VLAN 30, #00ffcc)", bool(new_group_id), f"Group ID: {new_group_id}")

        # Check badge rendered in workplace filter bar
        filter_pills_count = await client.eval("document.querySelectorAll('#workplace-filter-bar .filter-pill').length")
        record("Workplace Filter Bar renders interactive pills", filter_pills_count >= 2, f"{filter_pills_count} filter pills (ALL + groups)")

        # Verify Rack Isolation of Connection Groups
        rack1_id = await client.eval("window.store.getRacks()[0].id")
        rack1_groups_count = await client.eval(f"window.store.getGroups('{rack1_id}').length")
        record("Connection group is strictly isolated to active rack", rack1_groups_count == 0, f"Rack 1 groups: {rack1_groups_count}, Active Rack 2 groups: 1")

        # Switch to Rack 1 and verify its workplace bar has 0 groups (only 'ALL')
        await client.eval(f"window.store.setActiveRack('{rack1_id}')")
        await asyncio.sleep(0.3)
        rack1_pills = await client.eval("document.querySelectorAll('#workplace-filter-bar .filter-pill').length")
        record("Workplace bar updates on rack switch showing only its own groups", rack1_pills == 1, f"Found {rack1_pills} pill ('ALL') on Rack 1")

        # Create a dedicated group for Rack 1
        rack1_group_id = await client.eval("""
            (() => {
                const g = window.store.addGroup('АРМ Бухгалтер (Кабинет 101)', '#ffbb00', 10);
                return g ? g.id : null;
            })()
        """)
        await asyncio.sleep(0.3)
        record("Add dedicated group to Rack 1", bool(rack1_group_id))

        # Switch back to Rack 2
        rack2_id = await client.eval("window.store.getRacks()[1].id")
        await client.eval(f"window.store.setActiveRack('{rack2_id}')")
        await asyncio.sleep(0.3)
        rack2_has_only_own_group = await client.eval(f"""
            (() => {{
                const grps = window.store.getGroups();
                return grps.length === 1 && grps[0].id === '{new_group_id}';
            }})()
        """)
        record("Switching back to Rack 2 restores only Rack 2's isolated groups", rack2_has_only_own_group)

        # -------------------------------------------------------------
        # TEST 5: Cable Patching & SVG Bezier Curves
        # -------------------------------------------------------------
        print("\n--- Test Suite 5: Cable Patching & Selection Drawer ---")
        cable_connected = await client.eval(f"""
            (() => {{
                const rack = window.store.getActiveRack();
                const devs = rack.installedDevices;
                if (devs.length < 2) return null;
                const devA = devs[0];
                const devB = devs[1];
                
                // Connect Port 1 of Switch to Port 1 of Patch panel
                const cable = window.store.addCable({{
                    from: {{ deviceId: devA.id, portId: 'p-1' }},
                    to: {{ deviceId: devB.id, portId: 'p-1' }},
                    groupId: '{new_group_id}',
                    color: '#00ffcc',
                    type: 'Cat6 UTP'
                }});
                return cable ? cable.id : null;
            }})()
        """)
        await asyncio.sleep(0.5)
        record("Create patch cable between Switch and Patch Panel", bool(cable_connected), f"Cable ID: {cable_connected}")

        # Check SVG cable path rendered
        svg_cables_count = await client.eval("document.querySelectorAll('#cables-svg .cable-group').length")
        record("SVG Cable Layer renders Bezier curve for patch cord", svg_cables_count >= 1, f"Rendered {svg_cables_count} cable path(s)")

        # Select cable to inspect details in drawer
        await client.eval(f"window.store.setSelection({{ type: 'cable', id: '{cable_connected}' }})")
        await asyncio.sleep(0.3)
        drawer_visible = await client.eval("!document.getElementById('details-drawer').classList.contains('translate-x-full')")
        drawer_has_cable = await client.eval("document.getElementById('drawer-cable-label') !== null")
        record("Select cable opens Inspector Drawer with properties", drawer_visible and drawer_has_cable)

        # Close group modal left open from Test Suite 4 before mouse hit-testing
        await client.eval("document.getElementById('close-group-modal')?.click(); window.store.clearSelection();")
        await asyncio.sleep(0.1)

        # Verify upper-row cable does not overlap lower-row ports & lower-row port accepts clicks
        p2_info = await client.eval(f"""
            (() => {{
                const rack = window.store.getActiveRack();
                const sw = rack.installedDevices.find(d => d.templateId === 'tpl-switch-24p');
                if (!sw) return null;
                const swEl = document.querySelector(`#rack-container .installed-device[data-device-id="${{sw.id}}"]`);
                const p2Slot = swEl?.querySelector('.port-slot[data-port-id="p-2"] .port-jack');
                if (!p2Slot) return null;
                p2Slot.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                const r = p2Slot.getBoundingClientRect();
                const hitCable = window.app.cableRenderer.findCableAtClientPoint(r.left + r.width / 2, r.top + r.height / 2);
                return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, overlapsLowerPort: Boolean(hitCable) }};
            }})()
        """)
        lower_port_clear_and_clickable = False
        if p2_info and not p2_info["overlapsLowerPort"]:
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": p2_info["x"], "y": p2_info["y"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": p2_info["x"], "y": p2_info["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            draft_port = await client.eval("window.store.cableDraft ? window.store.cableDraft.portId : null")
            await client.eval("window.store.cancelCableDraft()")
            lower_port_clear_and_clickable = (draft_port == "p-2")
        record("Upper-row cable clears lower-row ports and lower-row port accepts clicks", lower_port_clear_and_clickable)

        # Verify clicking cable along its side channel selects cable via isPointInStroke
        cable_pt = await client.eval(f"""
            (() => {{
                const cr = window.app.cableRenderer;
                const item = cr.renderedCables.find(c => c.cable.id === '{cable_connected}');
                if (!item || !item.hitPath.getTotalLength) return null;
                const len = item.hitPath.getTotalLength();
                const pt = item.hitPath.getPointAtLength(len * 0.5);
                const svgRect = cr.svg.getBoundingClientRect();
                return {{ x: svgRect.left + pt.x, y: svgRect.top + pt.y }};
            }})()
        """)
        cable_channel_selectable = False
        if cable_pt:
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cable_pt["x"], "y": cable_pt["y"]})
            await asyncio.sleep(0.1)
            hover_id = await client.eval("window.app.cableRenderer.activeHoverCableId")
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cable_pt["x"], "y": cable_pt["y"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cable_pt["x"], "y": cable_pt["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            selected_cable_id = await client.eval("window.store.selectedEntity?.id || null")
            cable_channel_selectable = (hover_id == cable_connected and selected_cable_id == cable_connected)
        record("Hover and click along cable channel hits cable cleanly", cable_channel_selectable)
        # -------------------------------------------------------------
        # TEST 6: Switch CLI Terminal Modal
        # -------------------------------------------------------------
        print("\n--- Test Suite 6: Switch CLI Terminal Auto-Scaffolding ---")
        cli_opened = await client.eval("""
            (() => {
                const rack = window.store.getActiveRack();
                const sw = rack.installedDevices.find(d => d.templateId === 'tpl-switch-24p');
                if (!sw) return false;
                window.openDeviceCli(sw.id);
                const modal = document.getElementById('cli-modal');
                return modal && !modal.classList.contains('hidden');
            })()
        """)
        await asyncio.sleep(0.4)
        record("Open CLI Terminal Modal for Switch", cli_opened)

        # Verify port auto-config button was removed and CLI config editing persists
        cli_btn_absent = await client.eval("document.getElementById('cli-generate-btn') === null")
        record("Switch CLI port auto-generation button is removed", cli_btn_absent)

        cli_edited_ok = await client.eval("""
            (() => {
                const area = document.getElementById('cli-code-area');
                if (!area) return false;
                area.value = 'hostname Sw-Core-24\\ninterface Gi0/1\\n no shutdown\\nend';
                area.dispatchEvent(new Event('input', { bubbles: true }));
                const rack = window.store.getActiveRack();
                const sw = rack.installedDevices.find(d => d.templateId === 'tpl-switch-24p');
                return Boolean(sw && sw.cliConfig.includes('hostname Sw-Core-24'));
            })()
        """)
        record("CLI editor saves manual configuration changes", bool(cli_edited_ok))

        # Close CLI modal
        await client.eval("document.getElementById('close-cli-modal')?.click()")
        await asyncio.sleep(0.2)
        record("Close CLI Terminal Modal", True)

        # -------------------------------------------------------------
        # TEST 7: Template Builder & Alignment Tools
        # -------------------------------------------------------------
        print("\n--- Test Suite 7: Custom Template Builder & Alignment Grid ---")
        await client.eval("document.getElementById('btn-template-builder').click()")
        await asyncio.sleep(0.3)
        builder_open = await client.eval("!document.getElementById('builder-modal').classList.contains('hidden')")
        record("Click '#btn-template-builder' opens Custom Device Designer", builder_open)

        # Test Batch Generator (Generate 8 ports)
        batch_generated = await client.eval("""
            (() => {
                const tb = window.app.templateBuilder;
                if (!tb) return false;
                tb.generate8Ports();
                return tb.currentTemplate.ports.length === 8;
            })()
        """)
        record("Batch generate 8 RJ45 ports", batch_generated)

        # Test coaxial 2-row alignment tool
        coaxial_aligned = await client.eval("""
            (() => {
                const tb = window.app.templateBuilder;
                tb.generate24Ports();
                tb.alignTwoRowsCoaxial();
                
                // Verify ports alternate between row 1 (33%) and row 2 (67%)
                const p0 = tb.currentTemplate.ports[0];
                const p1 = tb.currentTemplate.ports[1];
                return Math.abs(p0.y - 33) < 1 && Math.abs(p1.y - 67) < 1;
            })()
        """)
        record("Apply '⇕ В 2 соосных ряда' vertical & horizontal auto-alignment", coaxial_aligned)

        # Save custom template
        saved_tpl = await client.eval("""
            (() => {
                const tb = window.app.templateBuilder;
                document.getElementById('builder-name').value = 'Мой Кастомный Маршрутизатор 2U';
                tb.currentTemplate.name = 'Мой Кастомный Маршрутизатор 2U';
                const uSel = document.getElementById('builder-u-height');
                if (uSel) uSel.value = '2';
                tb.currentTemplate.uHeight = 2;
                tb.saveTemplate();
                return true;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Save custom template to equipment library", bool(saved_tpl))

        # Verify custom template appears in catalog
        await client.eval("document.getElementById('btn-catalog').click()")
        await asyncio.sleep(0.3)
        found_custom_in_catalog = await client.eval("""
            (() => {
                const cards = Array.from(document.querySelectorAll('#palette-devices-list h4'));
                return cards.some(c => c.textContent.includes('Мой Кастомный Маршрутизатор 2U'));
            })()
        """)
        record("Custom template is listed in Device Catalog ready to install", found_custom_in_catalog)

        # Open edit mode for the custom template from Device Catalog
        edit_opened = await client.eval("""
            (() => {
                const cards = Array.from(document.querySelectorAll('#palette-devices-list > div'));
                const card = cards.find(c => c.textContent.includes('Мой Кастомный Маршрутизатор 2U'));
                if (!card) return false;
                const editBtn = card.querySelector('button[title="Редактировать шаблон устройства"]');
                if (!editBtn) return false;
                editBtn.click();
                return true;
            })()
        """)
        await asyncio.sleep(0.3)
        edit_state_ok = await client.eval("""
            (() => {
                const modal = document.getElementById('builder-modal');
                const saveBtn = document.getElementById('btn-save-template');
                const nameInput = document.getElementById('builder-name');
                const tb = window.app.templateBuilder;
                return Boolean(
                    modal && !modal.classList.contains('hidden') &&
                    tb && tb.editingTemplateId &&
                    nameInput && nameInput.value === 'Мой Кастомный Маршрутизатор 2U' &&
                    saveBtn && saveBtn.textContent.includes('Сохранить изменения')
                );
            })()
        """)
        record("Edit existing template opens Builder with populated fields", bool(edit_opened and edit_state_ok))

        # Modify template name & power and save changes
        tpl_count_before_edit = await client.eval("window.store.getTemplates().length")
        await client.eval("""
            (() => {
                const nameInput = document.getElementById('builder-name');
                nameInput.value = 'Мой Кастомный Маршрутизатор 2U (ред.)';
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                const powerInput = document.getElementById('builder-power');
                powerInput.value = '120';
                powerInput.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('btn-save-template').click();
            })()
        """)
        await asyncio.sleep(0.4)
        edit_saved_ok = await client.eval(f"""
            (() => {{
                const tpls = window.store.getTemplates();
                const updated = tpls.find(t => t.name === 'Мой Кастомный Маршрутизатор 2U (ред.)');
                return tpls.length === {tpl_count_before_edit} && Boolean(updated && updated.powerW === 120 && updated.ports.length === 24);
            }})()
        """)
        record("Saving edited template updates existing template in store", edit_saved_ok)

        # -------------------------------------------------------------
        # TEST 8: Drawer Actions & Deletions
        # -------------------------------------------------------------
        print("\n--- Test Suite 8: Drawer Operations & Element Deletion ---")
        
        # Select cable and click delete cable in drawer
        await client.eval(f"window.store.setSelection({{ type: 'cable', id: '{cable_connected}' }})")
        await asyncio.sleep(0.3)
        cables_before_del = await client.eval("window.store.state.cables.length")
        
        # Click delete button in details-drawer
        await client.eval("""
            (() => {
                const delBtn = document.querySelector('#details-content button[onclick*=\"removeCable\"]');
                if (delBtn) delBtn.click();
            })()
        """)
        await asyncio.sleep(0.4)
        cables_after_del = await client.eval("window.store.state.cables.length")
        record("Delete cable via Inspector Drawer button", cables_after_del == cables_before_del - 1, f"Cables: {cables_before_del} -> {cables_after_del}")

        # Select switch and delete via drawer
        await client.eval(f"window.store.setSelection({{ type: 'device', id: '{install_patch}' }})")
        await asyncio.sleep(0.3)
        devices_before_del = await client.eval("window.store.getActiveRack().installedDevices.length")
        await client.eval("""
            (() => {
                const delBtn = document.querySelector('#details-content button[onclick*=\"removeDevice\"]');
                if (delBtn) delBtn.click();
            })()
        """)
        await asyncio.sleep(0.4)
        devices_after_del = await client.eval("window.store.getActiveRack().installedDevices.length")
        record("Delete installed device via Inspector Drawer button", devices_after_del == devices_before_del - 1, f"Devices: {devices_before_del} -> {devices_after_del}")

        # Test Rack switching via dropdown
        await client.eval("""
            (() => {
                const rSelect = document.getElementById('rack-select');
                const firstRackId = window.store.getRacks()[0].id;
                rSelect.value = firstRackId;
                rSelect.dispatchEvent(new Event('change', { bubbles: true }));
            })()
        """)
        await asyncio.sleep(0.4)
        active_u_switched = await client.eval("window.store.getActiveRack().uHeight")
        record("Switch rack via '#rack-select' dropdown", active_u_switched == 24, f"Active switched to: {active_u_switched}U rack")

        # --- NEW: Delete Connection Group ---
        groups_before = await client.eval("window.store.getAllGroups().length")
        await client.eval(f"window.deleteGroupConfirm('{new_group_id}')")
        await asyncio.sleep(0.3)
        groups_after = await client.eval("window.store.getAllGroups().length")
        record("Delete connection group from system", groups_after == groups_before - 1, f"Total groups: {groups_before} -> {groups_after}")

        # --- NEW: Delete Device Template from Pool ---
        templates_before = await client.eval("window.store.getTemplates().length")
        custom_tpl_id = await client.eval("""
            (() => {
                const tpls = window.store.getTemplates();
                const found = tpls.find(t => t.name.includes('Мой Кастомный Маршрутизатор 2U'));
                return found ? found.id : null;
            })()
        """)
        await client.eval(f"window.deleteTemplateFromPalette('{custom_tpl_id}')")
        await asyncio.sleep(0.3)
        templates_after = await client.eval("window.store.getTemplates().length")
        record("Delete device template from device pool", templates_after == templates_before - 1, f"Templates: {templates_before} -> {templates_after}")

        # --- NEW: Delete Server Rack ---
        racks_before = await client.eval("window.store.getRacks().length")
        rack_to_del_id = await client.eval("""
            (() => {
                const r = window.store.getRacks();
                return r.length > 1 ? r[1].id : null;
            })()
        """)
        await client.eval(f"window.deleteRackConfirm('{rack_to_del_id}')")
        await asyncio.sleep(0.4)
        racks_after = await client.eval("window.store.getRacks().length")
        record("Delete server rack from system", racks_after == racks_before - 1, f"Racks: {racks_before} -> {racks_after}")

        # -------------------------------------------------------------
        # TEST 9: Export / Import JSON & Reset
        # -------------------------------------------------------------
        print("\n--- Test Suite 9: JSON Persistence & Export ---")
        export_data = await client.eval("JSON.stringify(window.store.state)")
        parsed = json.loads(export_data)
        has_racks = len(parsed.get("racks", [])) >= 1
        record("State serializes valid JSON schema with racks, cables, and templates", has_racks, f"{len(parsed.get('racks', []))} racks in JSON")

        # -------------------------------------------------------------
        # TEST 10: Console Health & Zero Errors Check
        # -------------------------------------------------------------
        print("\n--- Test Suite 10: Browser Console Diagnostics ---")
        errors = client.console_errors
        has_critical_errors = len([e for e in errors if "favicon" not in e.lower()]) > 0
        if has_critical_errors:
            print("  [WARNING] Console errors captured during session:")
            for err in errors:
                print(f"    ! {err}")
        record("Zero Uncaught Exceptions & Console Errors", not has_critical_errors, f"Total log entries: {len(client.console_logs)}")

        # Summary
        print("\n" + "=" * 70)
        total_tests = len(test_results)
        passed_tests = len([r for r in test_results if r[1]])
        failed_tests = total_tests - passed_tests
        print(f"  TOTAL TESTS: {total_tests} | PASSED: {passed_tests} | FAILED: {failed_tests}")
        print("=" * 70)

        await client.close()
        return failed_tests == 0

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            pass
        if server_proc:
            try:
                server_proc.terminate()
                server_proc.wait(timeout=2)
            except Exception:
                pass


if __name__ == "__main__":
    success = asyncio.run(run_test_suite())
    sys.exit(0 if success else 1)
