// Usage:
// - Create a txt file in VM with !hello-x86!fffffffffffffff (f repeated 4k+ times)
// - Paste the following script into dev tools
// - Click "upload tools" (pick vmtools.exe / vmtools_stub.exe)
// - Make sure the txt file has a .exe extension. Run the .exe (on windows 2000 you need to make a copy of the exe and run that instead).

// Windows 95 notes:
// Copy Windows/System/msvcrt40.dll next to vmtools.exe, rename it to msvcrt.dll
// Copy Windows/System/Wsock32.dll next to vmtools.exe, rename it to ws2_32.dll

// v86 notes:
// On v86 place a breakpoint on state.js (restore_object), step over the last line and enter into the console: HEAPU8=this.fa

// JSLinux notes:
// On jslinux append to the url "&net_url=" to avoid using the default net implementation (seems to invoke it in certain conditions anyway?)

// TODO: It might better performance wise to create a slightly larger search block (to skip more chars on each step)
// The 'F' is used to state what kind of buffer it is ('F'ile / 'M'emory)
// !vF!BlK:0000000[hDr]
var g_blockHeaderFooterLen = 20;
var g_blockHeaderFooterLenTotal = g_blockHeaderFooterLen * 2;
var g_blockHeaderFooterOffset = 15;
var g_blockIdStrIndex = 8;
var g_blockIdStrLen = 7;// Number of characters in the id number
var g_blockHeaderStr = "[hDr]";
var g_blockFooterStr = "[fTr]";
var g_blockStrPt1 = "!v";
var g_blockStrPt2 = "!BlK:";
var g_blockMemoryChar = "M";
var g_blockFileChar = "F";
// Block size should be set to fit perfectly with the paging of memory. This is important in order to
// find the header / footer when our blocks overlap two pages. Having a block size smaller than the page
// size means that the header text itself will eventually overlap with the page boundry (and we will no 
// longer find the header / footer due to header text being fragmented).
// - We currently wont find the footer if there is an overlap within the range of the header/footer length
//   e.g. a starting offset of 5 will make it impossible to find the end of the footer which between two pages.
//   An offset of 20+ should work (as it will be able to find the footer/header seperately)
//   - One possible fix is when we detect an overflap <= g_blockHeaderFooterLen then look backwards on each
//     found header block for the previous footer block, which should be directly behind. This would possibly 
//     mean we lose the last few bytes of the final block, but everything else should be available. It should be
//     noted that this issue could happen in reverse (headers are aligned somewhere around ~4094, in which case
//     the reverse needs to be done where we look for footer blocks and then get the headers based on that, but
//     not being able to find the first few bytes of the first block is a lot worse than the last few bytes of
//     the last block....)
//     TODO: !!!!!!!!!!!!FIXME!!!!!!!!!!!!
var g_blockSize = 4096;

var g_sharedDataOffset = 8;// Shared data comes after the host/guest magic

var g_lazyBlockForFirstFileTransfer = true;
var g_lazyBlockPrefix = "!hello-x86!";
var g_lazyBlockChar = "f";

var hostMagicComm = 0xE2B13904;
var hostMagicXfer = 0x8D93F023;
var hostMagicDead = 0x152339D9;
var guestMagicComm = 0x3904FEBB;
var guestMagicXfer = 0x16222FED;
var guestMagicDead = 0x1B880C2C;

var g_conStateDisconnected = 0;
var g_conStateConnecting = 1;
var g_conStateStubFileTransfer = 2;
var g_conStateFullyConnected = 3;

var USE_KEEP_ALIVE = false;
var KEEP_ALIVE_DELAY = 5000;
var KEEP_ALIVE_TIMEOUT = 30000;

var PT_MiscData = 0;
var PT_FileData = 1;
var PT_NetworkData = 2;
var PT_MAX = 3;

var MP_Clipboard = 0;
var MP_KeepAlive = 1;

var FT_HOST_TO_VM = 0;
var FT_VM_TO_HOST = 1;
var FT_DATA = 2;
var FT_END = 3;

var NT_HttpProxy = 0;
var NT_HttpsProxy = 1;
var NT_DnsProxy = 2;
var NT_SocksProxy = 3;
var NT_HttpProxyEmulated = 4;
var NT_HttpsProxyEmulated = 5;
var NT_MAX = 6;

var PROXY_CONNECT = 0;
var PROXY_DISCONNECT = 1;
var PROXY_RECV = 2;
var PROXY_SEND = 3;
var PROXY_RECV_UDP = 4;
var PROXY_SEND_UDP = 5;
var g_useSecureWebSockets = false;
var g_webSocketPort = 861;
var g_webSocketDnsPort = 862;
var g_webSocketHttpPort = 863;
var g_webSocketHttpsPort = 864;

var DOWNGRADE_HTTPS = true;// For emulated HTTP (no proxy server)

var SHARED_FOLDER_NAME = "Shared";
var USE_ZIP = true;// If true use .zip, if false use .tar
var AUTO_EXTRACT_ARCHIVES = true;// If true archive files (tar/zip) should be extracted then sent to the guest (only when 1 archive is sent)
// These will load the libs if AUTO_EXTRACT_ARCHIVES is enabled
var LOAD_ZIP_LIB = true;
var LOAD_TAR_LIB = true;

var g_vmm = null;

var bottomDiv = document.createElement("div");
bottomDiv.style.cssText = "position:fixed;bottom:0;right:0;";
document.body.appendChild(bottomDiv);

// webkitdirectory / mozdirectory can be used to load a folder
var uploadFilesInputField = document.createElement("input");
uploadFilesInputField.setAttribute("type", "file");
uploadFilesInputField.setAttribute("multiple", true);
uploadFilesInputField.style.cssText = "display:none";
uploadFilesInputField.addEventListener("change", onUploadFilesToVM, false);
bottomDiv.appendChild(uploadFilesInputField);

var uploadToolsInputField = document.createElement("input");
uploadToolsInputField.setAttribute("type", "file");
uploadToolsInputField.setAttribute("multiple", true);
uploadToolsInputField.style.cssText = "display:none";
uploadToolsInputField.addEventListener("change", onUploadToolsToVm, false);
bottomDiv.appendChild(uploadToolsInputField);

var uploadToolsBtn = document.createElement("button");
uploadToolsBtn.innerHTML = "upload tools";
uploadToolsBtn.onclick = uploadToolsToVM;
bottomDiv.appendChild(uploadToolsBtn);

var connectBtn = document.createElement("button");
connectBtn.innerHTML = "connect";
connectBtn.onclick = connectToVM;
bottomDiv.appendChild(connectBtn);

var getClipboardBtn = document.createElement("button");
getClipboardBtn.innerHTML = "getCB";
getClipboardBtn.onclick = getClipboard;
bottomDiv.appendChild(getClipboardBtn);

var setClipboardBtn = document.createElement("button");
setClipboardBtn.innerHTML = "setCB";
setClipboardBtn.onclick = setClipboard;
bottomDiv.appendChild(setClipboardBtn);

var getClipboardTb = document.createElement("input");
getClipboardTb.type = "text";
getClipboardTb.value = "getCB";
getClipboardTb.style.width = getClipboardBtn.offsetWidth + "px";
getClipboardTb.onmouseup = getClipboardTb.onfocus = function()
{
    if (!g_vmm.hasClipboardData)
    {
        getClipboardTb.value = "getCB";
    }
    //getClipboardTb.select();
};
getClipboardTb.oncopy = getClipboard;
bottomDiv.appendChild(getClipboardTb);

var setClipboardTb = document.createElement("input");
setClipboardTb.type = "text";
setClipboardTb.value = "setCB";
setClipboardTb.style.width = setClipboardBtn.offsetWidth + "px";
setClipboardTb.onmouseup = setClipboardTb.onfocus = function()
{
    setClipboardTb.value = "setCB";
    //setClipboardTb.select();
};
setClipboardTb.onpaste = setClipboard;
bottomDiv.appendChild(setClipboardTb);

var downloadFileBtn = document.createElement("button");
downloadFileBtn.innerHTML = "download";
downloadFileBtn.onclick = downloadFileFromVM;
bottomDiv.appendChild(downloadFileBtn);

var uploadFileBtn = document.createElement("button");
uploadFileBtn.innerHTML = "upload";
uploadFileBtn.onclick = uploadFileToVM;
bottomDiv.appendChild(uploadFileBtn);

// Two methods of setting the clipboard (one works with HTTPS, the other doesn't)
// jslinux consumes ALL input on the page?
if (location.protocol == 'https:')
{
    setClipboardTb.style.display = "none";
    getClipboardTb.style.display = "none";
}
else
{
    setClipboardBtn.style.display = "none";
    getClipboardBtn.style.display = "none";
}

function lazyLoadJs(libName, url, findStr, replaceStr)
{
    try
    {
        var xmlHttp = new XMLHttpRequest();
        xmlHttp.open("GET", url, true);
        xmlHttp.send(null);
        xmlHttp.onerror = function(e)
        {
            console.log("Failed to load " + libName + ": " + e);
        }
        xmlHttp.onload = function(e)
        {
            if (xmlHttp.readyState == 4)// DONE
            {
                try
                {
                    var result = xmlHttp.responseText;
                    if (findStr != null && replaceStr != null)
                    {
                        result = result.replace(findStr, replaceStr);
                    }
                    new Function(result)();
                    console.log("Loaded " + libName + "");
                }
                catch (err)
                {
                    console.log("Failed to load " + libName + ": " + err);
                }
            }
        }
    }
    catch (err)
    {
        console.log("Failed to load " + libName + ": " + err);
    }
}

function isJSZipLoaded()
{
    return typeof JSZip !== "undefined";
}

// Lazily download JSZip
if (!isJSZipLoaded() && (USE_ZIP || (AUTO_EXTRACT_ARCHIVES && LOAD_ZIP_LIB)))
{
    lazyLoadJs("JSZip", "https://raw.githubusercontent.com/Stuk/jszip/v2.x/dist/jszip.min.js", null, null);
}

function isTarballJsLoaded()
{
    return typeof tarball !== "undefined";
}

// Lazily download tarballjs
if (!isTarballJsLoaded() && (!USE_ZIP || (AUTO_EXTRACT_ARCHIVES && LOAD_TAR_LIB)))
{
    var findStr = "let tarball = ";
    var replaceStr = "window.tarball = ";
    lazyLoadJs("tarballjs", "https://raw.githubusercontent.com/ankitrohatgi/tarballjs/master/tarball.js", findStr, replaceStr);
}

function strReplaceAll(str, findStr, replaceWithStr)
{
    // This is like str.replace() but without regex
    return str.split(findStr).join(replaceWithStr);
}

function getClipboard(e)
{
    if (g_vmm.connectionState != g_conStateFullyConnected)
    {
        return;
    }
    if (e != null && e.clipboardData != null)
    {
        e.preventDefault();
        
        if (g_vmm.hasClipboardData)
        {
            getClipboardTb.value = "getCB";
            e.clipboardData.setData("text/plain", g_vmm.clipboardData);
            g_vmm.clipboardData = "";
            g_vmm.hasClipboardData = false;
            return;
        }
        getClipboardTb.value = "fetching...";
    }
    g_vmm.queuePacket_GetClipboardData();
}

function setClipboard(e)
{
    if (g_vmm.connectionState != g_conStateFullyConnected)
    {
        return;
    }
    if (e != null && e.clipboardData != null)
    {
        var text = e.clipboardData.getData("text/plain");
        if (text != null && text.length > 0)
        {
            g_vmm.queuePacket_SetClipboardText(text);
        }
        e.preventDefault();
    }
    if (typeof(navigator) !== "undefined" && navigator.clipboard != null)
    {
        try
        {
            navigator.clipboard.readText().then(text => g_vmm.queuePacket_SetClipboardText(text));
        }
        catch (err)
        {
            console.log("Failed to get clipboard text");
        }
    }
}

function uploadToolsToVM()
{
	if (!g_vmm.validateHeap())
	{
		return;
	}
	if (g_vmm.fileBlocks == null)
	{
		g_vmm.findFileBlocks();
		if (g_vmm.fileBlocks == null)
		{
			return;
		}
	}
    g_vmm.toolsFileBuffer = null;
    uploadToolsInputField.value = "";
	uploadToolsInputField.click();
}

function tryCancelFileTransfer()
{
    if (g_vmm.fileTransfer.Direction == FT_VM_TO_HOST)
    {
        g_vmm.queuePacket_GetFilesFromVMCancel();
        return true;
    }
    else if (g_vmm.fileTransfer.Direction == FT_HOST_TO_VM)
    {
        g_vmm.queuePacket_SendFilesToVMEnd(true);
        g_vmm.resetFileTransfer();
        return true;
    }
    return false;
}

function uploadFileToVM()
{
	if (g_vmm.connectionState != g_conStateFullyConnected)
	{
		return;
	}
    if (tryCancelFileTransfer())
    {
        return;
    }
    uploadFilesInputField.value = "";
	uploadFilesInputField.click();
}

function downloadFileFromVM()
{
	if (g_vmm.connectionState != g_conStateFullyConnected)
	{
		return;
	}
    if (tryCancelFileTransfer())
    {
        return;
    }
    g_vmm.fileTransfer.Direction = FT_VM_TO_HOST;
    g_vmm.onBeginFileTransfer();
    g_vmm.queuePacket_GetFilesFromVM();
}

function onUploadFilesToVM()
{
    if (g_vmm.fileTransfer.Direction >= 0)
    {
        // Already transferring files?
        return;
    }

    var files = uploadFilesInputField.files;
    
	for (var i = 0; i < files.length; i++)
	{
        var fileInfo = {};
        fileInfo.HasOpenedFile = false;
        fileInfo.File = files[i];
        fileInfo.Path = files[i].name;
        fileInfo.IsDirectory = false;
        fileInfo.Data = null;
        fileInfo.Offset = 0;
        fileInfo.Length = files[i].size;
        fileInfo.FileReader = new FileReader();
        g_vmm.fileTransfer.Files.push(fileInfo);
	}
    
    if (g_vmm.fileTransfer.Files.length > 0)
    {
        g_vmm.fileTransfer.Direction = FT_HOST_TO_VM;
        g_vmm.fileTransfer.CurrentFileIndex = 0;
        g_vmm.onBeginFileTransfer();
        g_vmm.queuePacket_SendFilesToVM();
        g_vmm.queuePacket_SendFilesToVMDataNext();
    }
}

function onUploadToolsToVm()
{
    var onLoadedCallback = function(files)
    {
        if (g_vmm.fileBlocks != null && g_vmm.connectionState == g_conStateDisconnected)
        {
            for (var i = 0; i < files.length; i++)
            {
                var fileInfo = files[i];
                var fileName = fileInfo.name;
                var fileBuffer = fileInfo.buffer;
                
                if (files.length != 2)
                {
                    console.log("Invalid upload. Expected 2 files, found " + files.length + ".");
                    break;
                }
                if (g_vmm.fileBlocks != null)
                {
                    if (fileName.includes("_stub.exe"))
                    {
                        if (fileBuffer.length > g_vmm.fileBlocks.numBytes)
                        {
                            alert("File '" + fileName + "' is too big to transfer.");
                        }
                        else
                        {
                            g_vmm.writeBytes(g_vmm.fileBlocks, 0, fileBuffer);
                            g_vmm.fileBlocks = null;
                            console.log("Transferred file!");
                        }
                    }
                    else
                    {
                        g_vmm.toolsFileBuffer = fileBuffer;
                    }
                }
            }
        }
    };
    
    var files = uploadToolsInputField.files;
    
	var loadedFiles = [];
	var count = files.length;
	for (var i = 0; i < files.length; i++)
	{
		var file = files[i];
		var fileReader = new FileReader();
		fileReader.file = file;
		fileReader.onload = function()
		{
			var fileBuffer = new Uint8Array(this.result);
			loadedFiles.push({name: this.file.name, buffer: fileBuffer});
			if (--count == 0)
			{
				onLoadedCallback(loadedFiles);
			}
		}
		fileReader.readAsArrayBuffer(file);
	}
}

// "Virtual mapped memory"
function VMM()
{
	this.memoryBlocks = null;
	this.fileBlocks = null;
	
	this.memoryBlocksCount = 256;
	this.fileBlocksCount = 256;
	
	this.heapU8 = null;
	
	this.connectionState = g_conStateDisconnected;
    this.toolsFileBuffer = null;
    this.proxyConnections = [];
    
    this.clipboardData = "";
    this.hasClipboardData = false;
    getClipboardTb.value = "getCB";
    
    this.fileTransfer = {};
    this.fileTransfer.Files = [];
    this.fileTransfer.CurrentFileIndex = -1;
    this.fileTransfer.Direction = -1;
    this.fileTransfer.BaseDirectory = null;
    
    this.lastData = 0;
    this.lastKeepAlive = 0;
    this.lastSendKeepAlive = 0;
}

VMM.prototype.findBuffer = function(haystack, needle)
{
	// TODO: Use a faster algorithm for this
	var result = [];
	var haystackLen = haystack.length;
	var needleLen = needle.length;
	var limit = haystackLen - needleLen;
	for (var i = 0; i < limit; i++)
	{
		var j;
		for (j = 0; j < needleLen; j++)
		{
			if (haystack[i + j] != needle[j])
			{
				break;
			}
		}
		
		if (j == needleLen)
		{
			result.push(i);
		}
	}
	return result;
};

// https://gist.github.com/jhermsmeier/2138865
VMM.prototype.findBufferBoyerMooreHorspool = function(haystack, needle)
{
	var result = [];

	var start = 0;
	var nlen = needle.length;
	var hlen = haystack.length;
	
	if (nlen <= 0 || hlen <= 0)
	{
		return result;
	}
	
	var jump, offset = start || 0;
	var scan = 0;
	var last = nlen - 1;
	var skip = {}
	
	for (scan = 0; scan < last; scan++)
	{
		skip[needle[scan]] = last - scan;
	}
	
	var cnt = 0;
	while (hlen >= nlen)
	{
		cnt++;
		jump = -1;
		for (scan = last; haystack[offset + scan] === needle[scan]; scan--)
		{
			if (scan === 0)
			{
				result.push(offset);
				jump = 1;
				break;
			}
		}
		if (jump <= 0)
		{
			jump = skip[haystack[ offset + last ]];
			jump = jump != null ? jump : nlen;
		}
		hlen -= jump
		offset += jump
	}
	return result;
};

VMM.prototype.findBufferBoyerMoore = function(haystack, needle)
{
	var result = [];

	var i, k;
	var n = needle.length;
	var m = haystack.length;
	var jump;
	
	if (n === 0)
	{
		return result;
	}
	
	var charTable = this.findBufferBoyerMoore_makeCharTable(needle);
	var offsetTable = this.findBufferBoyerMoore_makeOffsetTable(needle);
	
	var cnt = 0;
	for (i = n - 1; i < m;)
	{
		jump = -1;
		for (k = n - 1; needle[k] === haystack[i]; --i, --k)
		{
			if (k === 0)
			{
				result.push(i);
				break;
			}
		}
		// i += (n - k); // for naive method
		i += Math.max(offsetTable[n - 1 - k], charTable[haystack[i]]);
		cnt++;
	}
	
	return result;
};

VMM.prototype.findBufferBoyerMoore_makeCharTable = function(needle)
{
	var table = new Uint32Array(256);//this.alphabetSize);
	var n = needle.length;
	var t = table.length;
	var i = 0;
	for (; i < t; ++i)
	{
		table[i] = n;
	}
	n--;
	for (i = 0; i < n; ++i)
	{
		table[needle[i]] = n - i;
	}
	return table;
};

VMM.prototype.findBufferBoyerMoore_makeOffsetTable = function(needle)
{
	var i, suffix;
	var n = needle.length;
	var m = n - 1;
	var lastPrefix = n;
	var table = new Uint32Array(n);
	for (i = m; i >= 0; --i)
	{
		if (this.findBufferBoyerMoore_isPrefix(needle, i + 1))
		{
			lastPrefix = i + 1;
		}
		table[m - i] = lastPrefix - i + m;
	}
	for (i = 0; i < n; ++i)
	{
		suffix = this.findBufferBoyerMoore_suffixLength(needle, i);
		table[suffix] = m - i + suffix;
	}
	return table;
};

VMM.prototype.findBufferBoyerMoore_isPrefix = function(needle, i)
{
	var k = 0;
	var n = needle.length;
	for (; i < n; ++i, ++k)
	{
		if (needle[i] !== needle[k])
		{
			return false;
		}
	}
	return true;
};

VMM.prototype.findBufferBoyerMoore_suffixLength = function(needle, i)
{
	var k = 0;
	var n = needle.length;
	var m = n - 1;
	for (; i >= 0 && needle[i] === needle[m]; --i, --m)
	{
		k += 1;
	}
	return k;
};

VMM.prototype.findBlocksHalf = function(blockType, offsets, isHeader, numBlocksToFind)
{
	var blocks = [];
	var count = 0;
	
	// To find the size of the blocks based on the most common block size
	var blockLensArr = [];
	var blockLensCnt = -1;
	var blockLens = -1;
	
	var hdrFtrType = isHeader ? g_blockHeaderStr : g_blockFooterStr;
	
	for (var i = 0; i < offsets.length; i++)
	{
		var blockOffset = offsets[i];
		var validBlock = true;
		for (var j = 0; j < hdrFtrType.length; j++)
		{
			if (this.heapU8[blockOffset + g_blockHeaderFooterOffset + j] != hdrFtrType.charCodeAt(j))
			{
				validBlock = false;
			}
		}
		if (validBlock)
		{
			var blockId = "";
			for (var j = 0; j < g_blockIdStrLen; j++)
			{
				blockId += String.fromCharCode(this.heapU8[blockOffset + g_blockIdStrIndex + j]);
			}
			blockId = blockId | 0;// Convert it to an integer
			var blockLen = 0;
			if (isHeader)
			{
				for (var j = g_blockHeaderFooterLen; j < g_blockSize; j++)
				{
					if (String.fromCharCode(this.heapU8[blockOffset + j]) != blockType)
					{
						blockLen = j;
						break;
					}
				}
			}
			if (blocks[blockId] !== undefined)
			{
				console.log("TODO: Handle duplicate blocks. BlockId: " + blockId + " lengthA:" + blocks[blockId].length + " lengthB:" + blockLen);
				continue;
			}
			blocks[blockId] = { id:blockId, length:blockLen, memOffset:blockOffset };
			if (isHeader)
			{
				if (blockLensArr[blockLen] == null)
				{
					blockLensArr[blockLen] = 1;
				}
				else
				{
					blockLensArr[blockLen]++;
				}
				if (blockLensArr[blockLen] > blockLensCnt)
				{
					blockLens = blockLen;
					blockLensCnt = blockLensArr[blockLen];
				}
			}
			count++;
		}
	}
	if (count != numBlocksToFind)
	{
		alert("Failed to find all blocks for '" + hdrFtrType + "' found: " + count + " expected: " + numBlocksToFind);
		return null;
	}
	if (isHeader && blockLens == g_blockSize - g_blockHeaderFooterLen)
	{
		// The header is aligned perfectly within a page boundry. There shouldn't be any reason to look
		// for the footer (as we already know where it is) TODO: Validate the footer here.
		blockLens = g_blockSize;
	}
	var hasMissingBlock = false;
	for (var i = 0; i < blocks.length; i++)
	{
		if (blocks[i] == null)
		{
			alert("Missing block " + i);
			hasMissingBlock = true;
			continue;
		}
		if (isHeader)
		{
			// Make sure all of the block lengths are correct
			blocks[i].length = blockLens;
		}
	}
	if (hasMissingBlock)
	{
		return null;
	}
	return blocks;
};

VMM.prototype.findBlocksLazy = function()
{
	var bufferToFind = [];
	for (var i = 0; i < g_blockSize; i++)
	{
		if (i < g_lazyBlockPrefix.length)
		{
			bufferToFind[i] = g_lazyBlockPrefix.charCodeAt(i);
		}
		else
		{
			bufferToFind[i] = g_lazyBlockChar.charCodeAt(0);
		}
	}
	var offsets = this.findBufferBoyerMoore(this.heapU8, bufferToFind);
	if (offsets.length == 1)
	{
		var hdrBlocks = [];
		var ftrBlocks = null;
		
		// Only 1 block
		hdrBlocks[0] = { id:0, length:g_blockSize, memOffset:offsets[0] };
		
		var result = {hdrBlocks:hdrBlocks,ftrBlocks:ftrBlocks};
		result.numBlocks = hdrBlocks.length;
		result.numBytes = g_blockSize;
		result.indexToBlockMap = [];
		for (var j = 0; j < result.hdrBlocks[0].length; j++)
		{
			result.indexToBlockMap[j] = { block:result.hdrBlocks[0], blockOffset:j };
		}
		
		var zeroFill = new Uint8Array(result.numBytes);
		zeroFill.fill(0);
		this.writeBytes(result, 0, zeroFill);
		
		return result;
	}
	else if (offsets.length > 1)
	{
		alert("Found too many blocks for lazy block mode! Found: " + offsets.length + " expected: 1");
	}
	else
	{
		alert("Failed to find the block! The text should be '" + g_lazyBlockPrefix + "' followed by '" + g_lazyBlockChar + "' repeated 4096+ times");
	}
	return null;
};

VMM.prototype.findBlocks = function(blockType, numBlocksToFind)
{
	// Scan the memory for our target buffer
	var bufferToFind = [];
	var bufferToFindStr = g_blockStrPt1 + blockType + g_blockStrPt2;
	for (var i = 0; i < bufferToFindStr.length; i++)
	{
		bufferToFind[i] = bufferToFindStr.charCodeAt(i);
	}
	var timer = performance.now();
	// this.findBuffer this.findBufferBoyerMoore this.findBufferBoyerMooreHorspool
	// this.findBufferBoyerMoore - seems to work the best for short strings
	var offsets = this.findBufferBoyerMoore(this.heapU8, bufferToFind);
	console.log("Memory scan took " + (performance.now() - timer) + " milliseconds. Found " + offsets.length + " matches for '" + bufferToFindStr + "'");
	
	var hdrBlocks = this.findBlocksHalf(blockType, offsets, true, numBlocksToFind);
	if (hdrBlocks != null)
	{
		var ftrBlocks = null;
		// If the header block lengths aren't the desired block size then the footer is in a seperate memory page
		if (hdrBlocks[0].length != g_blockSize)
		{
			if (g_blockSize - hdrBlocks[0].length <= g_blockHeaderFooterLen)
			{
				alert("Allocated blocks overlap a page boundry! TODO: Improve block scanning (see !!!FIXME!!!)");
				return null;
			}
		
			// NOTE: this code path hasn't been tested yet!
			var ftrBlocks = this.findBlocksHalf(blockType, offsets, false, numBlocksToFind);
			if (ftrBlocks != null)
			{
				for (var i = 0; i < ftrBlocks.length; i++)
				{
					ftrBlocks[i].length = g_blockSize - hdrBlocks[i].length;
					ftrBlocks[i].memOffset -= (ftrBlocks[i].length - g_blockHeaderFooterLen);
					
					// Print the footer string
					/*var str = "";
					for (var j = 0; j < ftrBlocks[i].length; j++)
					{
						str += String.fromCharCode(this.heapU8[ftrBlocks[i].memOffset + j]);
					}
					console.log("Block " + i + " " + hdrBlocks[i].length + " " + ftrBlocks[i].length +
						" " + (hdrBlocks[i].length + ftrBlocks[i].length) + " " + str);*/
				}
			}
			else
			{
				// Something went wrong with getting the footer blocks
				return null;
			}
		}
		else
		{ 
			console.log("Header blocks are perfectly aligned!");
		}
		
		var result = {hdrBlocks:hdrBlocks,ftrBlocks:ftrBlocks};
		result.numBlocks = hdrBlocks.length;
		result.numBytes = g_blockSize * numBlocksToFind;
		result.indexToBlockMap = [];
		var indx = 0;
		for (var i = 0; i < result.numBlocks; i++)
		{
			for (var j = 0; j < result.hdrBlocks[i].length; j++)
			{
				result.indexToBlockMap[indx++] = { block:result.hdrBlocks[i], blockOffset:j };
			}
			if (result.ftrBlocks != null)
			{
				for (var j = 0; j < result.ftrBlocks[i].length; j++)
				{
					result.indexToBlockMap[indx++] = { block:result.ftrBlocks[i], blockOffset:j };
				}
			}
		}
		
		timer = performance.now();
		var blocksValid = this.validateBlocks(result, numBlocksToFind, blockType);
		console.log("validateBlocks(" + blocksValid + ") took " + (performance.now() - timer) + " milliseconds");
		
		// Zero fill the blocks so that we don't find these blocks in future scans
		var zeroFill = new Uint8Array(result.numBytes);
		zeroFill.fill(0);
		this.writeBytes(result, 0, zeroFill);
		
		return result;
	}
	return null;
};

VMM.prototype.validateBlocks = function(blocks, numBlocks, blockType)
{
	var fullBuffer = this.readBytes(blocks, 0, blocks.numBytes);
	var validationStr = "";
	var blodyBodyStr = blockType.repeat(g_blockSize - g_blockHeaderFooterLenTotal);
	var bufferToFindStr = g_blockStrPt1 + blockType + g_blockStrPt2;
	for (var i = 0; i < numBlocks; i++)
	{
		validationStr += bufferToFindStr;
		validationStr += ("" + i).padStart(g_blockIdStrLen, "0");
		validationStr += g_blockHeaderStr;
		
		validationStr += blodyBodyStr;
		
		validationStr += bufferToFindStr;
		validationStr += ("" + i).padStart(g_blockIdStrLen, "0");
		validationStr += g_blockFooterStr;
	}
	if (validationStr.length != fullBuffer.length)
	{
		return false;
	}
	for (var i = 0; i < fullBuffer.length; i++)
	{
		if (validationStr.charCodeAt(i) != fullBuffer[i])
		{
            /*console.log(validationStr);
            var fullBufferStr = "";
            for (var j = 0; j < fullBuffer.length; j++)
            {
                fullBufferStr += String.fromCharCode(fullBuffer[j]);
            }
            console.log(fullBufferStr);*/
			return false;
		}
	}
	return true;
};

VMM.prototype.readBytes = function(blocks, index, count)
{
	if (index < 0 || count < 0 || index + count > blocks.indexToBlockMap.length)
	{
        var err = "Invalid read at " + index;
        throw err;
		//console.log(err);
        //debugger;
		return null;
	}
	var result = new Uint8Array(count);
	for (var i = 0; i < count;)
	{
		var mappedBlock = blocks.indexToBlockMap[index + i];
        if (mappedBlock == null)
        {
            console.error("Out of bounds read at " + (index + i) + " allocated bytes: " + blocks.numBytes);
        }
		for (var j = mappedBlock.blockOffset; i < count && j < mappedBlock.block.length; j++, i++)
		{
			result[i] = this.heapU8[mappedBlock.block.memOffset + j];
		}
	}
	return result;
};

VMM.prototype.writeBytes = function(blocks, index, bytes)
{
	if (index < 0 || bytes == null || index + bytes.length > blocks.indexToBlockMap.length)
	{
        var err = "Invalid write at " + index;
        throw err;
		//console.log(err);
        //debugger;
		return null;
	}
	for (var i = 0; i < bytes.length;)
	{
		var mappedBlock = blocks.indexToBlockMap[index + i];
        if (mappedBlock == null)
        {
            console.error("Out of bounds write at " + (index + i) + " allocated bytes: " + blocks.numBytes);
        }
		for (var j = mappedBlock.blockOffset; i < bytes.length && j < mappedBlock.block.length; j++, i++)
		{
			this.heapU8[mappedBlock.block.memOffset + j] = bytes[i];
		}
	}
};

VMM.prototype.readU8 = function(blocks, index)
{
	return this.readBytes(blocks, index, 1)[0];
};

VMM.prototype.writeU8 = function(blocks, index, value)
{
	var arr = new Uint8Array(1);
	arr[0] = value;
	this.writeBytes(blocks, index, arr);
};

VMM.prototype.readU32 = function(blocks, index)
{
	var arr = new Uint32Array(this.readBytes(blocks, index, 4).buffer);
	return arr[0];
};

VMM.prototype.writeU32 = function(blocks, index, value)
{
	var arr = new Uint32Array(1);
	arr[0] = value;
	this.writeBytes(blocks, index, new Uint8Array(arr.buffer));
};

VMM.prototype.findMemoryBlocks = function()
{
	this.memoryBlocks = this.findBlocks(g_blockMemoryChar, this.memoryBlocksCount);
};

VMM.prototype.findFileBlocks = function()
{
	if (g_lazyBlockForFirstFileTransfer)
	{
		this.fileBlocks = this.findBlocksLazy();
	}
	else
	{
		this.fileBlocks = this.findBlocks(g_blockFileChar, this.fileBlocksCount);
	}
};

VMM.prototype.validateHeap = function()
{
	if (typeof HEAPU8 !== 'undefined' && this.heapU8 != HEAPU8)
	{
		this.heapU8 = HEAPU8;
	}
	if (this.heapU8 == null)
	{
		alert("Couldn't locate the CPU buffer.\n\nIf you are running v86 you open your browser developer tools and place a breakpoint on /build/src/cpu.js 'this.mem16 = new Uint16Array(buffer);'. Find the real buffer name of 'mem8' by looking at locals, which should be an array the same size as the 'size' variable (there may be multiple, note down all of the names you find). Place a breakpoint on build/src/state.js 'restore_object(this, state_object, buffers);' then step over that call, in the console window type HEAPU8=this.XXXXX; where XXXXX is the name of the array variable you found in the previous step. You need to do this every time you refresh the page or load the state. The variable name should only change when a new build of v86 is released which should be roughly based on https://github.com/copy/v86/commits/master.");
		return false;
	}
	return this.heapU8 != null;
};

function connectToVM()
{
	if (!g_vmm.validateHeap())
	{
        console.log("Failed to find the heap, or it's invalid.");
		return;
	}
    if (g_vmm.connectionState == g_conStateFullyConnected)
    {
        g_vmm.setDisconnected();
        return;
    }
    if (g_vmm.connectionState != g_conStateDisconnected)
    {
        console.log("Already connecting / connected.");
        return;
    }
	if (g_vmm.memoryBlocks == null)
	{
		g_vmm.findMemoryBlocks();
		if (g_vmm.memoryBlocks == null)
		{
            console.log("Failed to find the shared memory.");
			return;
		}
	}
	g_vmm.connectionState = g_conStateConnecting;
	g_vmm.writeU32(g_vmm.memoryBlocks, 0, hostMagicComm);
}

VMM.prototype.initPacketOffsets = function()
{
    var TOTAL_PACKET_BLOCKS = (PT_MAX * 2);
    this.PACKET_BLOCK_SIZE = (((g_blockSize * this.memoryBlocksCount) - g_sharedDataOffset) / TOTAL_PACKET_BLOCKS) | 0;
    this.packetOffsets = new Array(TOTAL_PACKET_BLOCKS);
    var offset = g_sharedDataOffset;
    var blockSize = this.PACKET_BLOCK_SIZE;
    for (var i = 0; i < TOTAL_PACKET_BLOCKS; i++)
    {
        this.packetOffsets[i] = offset;
        offset += blockSize;
    }
    this.packetReaders = new Array(PT_MAX);
    this.packetWriters = new Array(PT_MAX);
    for (var i = 0; i < PT_MAX; i++)
    {
        this.packetReaders[i] = null;
        this.packetWriters[i] = null;
    }
    this.MAX_QUEUED_PACKETS = 0xFFFF;
    this.PACKET_BLOCK_HEADER_SIZE = 17;
    this.PACKET_BLOCK_DATA_SIZE = this.PACKET_BLOCK_SIZE - this.PACKET_BLOCK_HEADER_SIZE;
    console.log("Packet block size: " + this.PACKET_BLOCK_SIZE);
    
    this.proxyConnections.length = 0;
};

function bufferToAscii(buffer)
{
    return String.fromCharCode.apply(null, buffer);
}

function asciiToBuffer(str)
{
    var len = str.length;
    var buffer = new Uint8Array(len);
    for (var i = 0; i < len; i++)
    {
        buffer[i] = str.charCodeAt(i);
    }
    return buffer;
}

function bufferToUtf16(buffer)
{
    // The passed in param should be an ArrayBuffer (not a Uint8Array or similar)
    return String.fromCharCode.apply(null, new Uint16Array(buffer));
}

function utf16ToBuffer(str)
{
    // The result is an ArrayBuffer (not a Uint8Array or similar)
    var len = str.length;
    var arrayBuffer = new ArrayBuffer(len * 2);
    var buffer = new Uint16Array(arrayBuffer);
    for (var i = 0; i < len; i++)
    {
        buffer[i] = str.charCodeAt(i);
    }
    return arrayBuffer;
}

VMM.prototype.parseHttpQuery = function(connection, query)
{
    var result = new Map();
    var lines = strReplaceAll(query, "\r\n", "\n").split("\n");
    var ret = 0;
    // Extract requested URL
    if (lines.length > 0)
    {
        ret = lines[0].indexOf(" ");
        if (ret > 0)
        {
            // Parse the Http Request Type
            connection.HttpRequestType = lines[0].substring(0, ret);
            lines[0] = lines[0].substring(ret).trim();
        }
        // Parse the Http Version and the Requested Path
        ret = lines[0].lastIndexOf(" ");
        if (ret > 0)
        {
            connection.HttpVersion = lines[0].substring(ret).trim();
            connection.RequestedPath = lines[0].substring(0, ret);
        }
        else
        {
            connection.RequestedPath = lines[0];
        }
        // Remove http:// if present
        if (connection.RequestedPath.length >= 7 && connection.RequestedPath.substring(0, 7).toLowerCase() == "http://")
        {
            ret = connection.RequestedPath.indexOf("/", 7);
            if (ret == -1)
            {
                connection.RequestedPath = "/";
            }
            else
            {
                connection.RequestedPath = connection.RequestedPath.substring(ret);
            }
        }
        for (var cnt = 1; cnt < lines.length; cnt++)
        {
            ret = lines[cnt].indexOf(":");
            if (ret > 0 && ret < lines[cnt].length - 1)
            {
                result.set(lines[cnt].substring(0, ret).toLowerCase(), lines[cnt].substring(ret + 1).trim());
            }
        }
    }
    return result;
};

VMM.prototype.isValidHttpQuery = function(connection, query)
{
    var index = query.indexOf("\r\n\r\n");
    if (index == -1)
    {
        return false;
    }
    var headerFields = this.parseHttpQuery(connection, query);
    if (connection.HttpRequestType.toUpperCase() == "POST")
    {
        var length = headerFields.get("content-length");
        if (length == null)
        {
            this.sendBadHttpRequest(connection);
            return true;
        }
        else
        {
            return query.length >= index + 6 + length;
        }
    }
    return true;
};

VMM.prototype.clearHttpRequestInfo = function(connection)
{
    connection.HttpQuery = "";
    connection.HttpRequestType = "";
    connection.RequestedPath = "";
    connection.HttpVersion = "";
    connection.HeaderFields = null;
    connection.HttpRequestBuffer.length = 0;
    connection.HttpPostBuffer = null;
};

VMM.prototype.processHttpQuery = function(connection, query)
{
    connection.HeaderFields = this.parseHttpQuery(connection, query);
    if (connection.HeaderFields == null || connection.HeaderFields.get("host") == null)
    {
        this.sendBadHttpRequest(connection);
        return;
    }
    
    var port = 0;
    var host = "";
    var ret = 0;
    if (connection.HttpRequestType.toUpperCase() == "CONNECT")
    {
        console.log("TODO: https");
    }
    else
    {
        ret = connection.HeaderFields.get("host").indexOf(":");
        if (ret > 0)
        {
            host = connection.HeaderFields.get("host").substring(0, ret);
            host = connection.HeaderFields.get("host").substring(ret + 1) | 0;
        }
        else
        {
            host = connection.HeaderFields.get("host");
            port = 80;
        }
        if (connection.HttpRequestType.toUpperCase() == "POST")
        {
            var index = query.indexOf("\r\n\r\n") + 4;
            if (connection.HttpRequestBuffer.length > index)
            {
                connection.HttpPostBuffer = new Uint8Array(connection.HttpRequestBuffer.slice(index));
            }
        }
        
        //console.log("url: " + connection.RequestedPath);
        //console.log("HTTP Handle request " + query);
        
        try
        {
            // Cache what we need, then clear the state to allow for future requests on the same socket.
            var httpRequestType = connection.HttpRequestType;
            var httpRequestHeaderFields = connection.HeaderFields;
            var httpRequestPostBuffer = connection.HttpPostBuffer;
            var httpRequestedPath = connection.RequestedPath;
            var httpVersion = connection.HttpVersion;
            this.clearHttpRequestInfo(connection);
            
            // Need a reference to "this" for the request callbacks
            var vmm = this;
            var requestRedirected = false;
            
            var request = new XMLHttpRequest();
            request.responseType = "arraybuffer";
            request.onreadystatechange = function(e)
            {
                if (!requestRedirected && request.readyState == 2)// HEADERS_RECEIVED
                {
                    var responseURL = new URL(request.responseURL);
                    if (host != responseURL.host || httpRequestedPath != responseURL.pathname)
                    {
                        var redirectUrl = "http://" + responseURL.host + responseURL.pathname;
                        //console.log("redirect to '" + redirectUrl + "'");
                        vmm.sendHttpContentMoved(connection, redirectUrl);
                        requestRedirected = true;
                        request.abort();
                    }
                }
            };
            request.onload = function(e)
            {
                // TODO: Handle large files better
                if (!requestRedirected && request.readyState == 4)// DONE
                {
                    if (connection.IsClosed)
                    {
                        return;
                    }
                    try
                    {
                        var responseHeadersStr = request.getAllResponseHeaders();
                        if (request.response != null && responseHeadersStr != null)
                        {
                            var responseBuffer = new Uint8Array(request.response);
                            
                            // Get the response headers
                            var splitted = responseHeadersStr.trim().split(/[\r\n]+/);
                            var responseHeaders = new Map();
                            splitted.forEach(function(line)
                            {
                                var parts = line.split(': ');
                                var header = parts.shift();
                                var value = parts.join(': ');
                                responseHeaders.set(header, value);
                            });
                            
                            if (DOWNGRADE_HTTPS)
                            {
                                var contentType = responseHeaders.get("content-type");
                                if (contentType != null && (contentType.includes("text/html") ||
                                    contentType.includes("text/css") || contentType.includes("text/javascript") ||
                                    contentType.includes("application/xml") || contentType.includes("text/xml")))
                                {
                                    // TODO: Support for different text encodings
                                    var contentStr = new TextDecoder("utf-8").decode(responseBuffer);
                                    contentStr = strReplaceAll(contentStr, "https://", "http://");
                                    responseBuffer = new Uint8Array((new TextEncoder("utf-8").encode(contentStr)));
                                    
                                    // TODO: Update the content length rather than removing it?
                                    responseHeaders.delete("content-length");
                                }
                            }
                            
                            // TODO: Handle "transfer-encoding" (chunked)
                            responseHeaders.delete("transfer-encoding");
                            
                            // Remove "content-encoding" as the content has already been decoded
                            responseHeaders.delete("content-encoding");
                        }
                        else
                        {
                            vmm.sendBadHttpRequest(connection);
                            return;
                        }
                        
                        // Closing the connection might not be required, but we are doing it for now.
                        responseHeaders.set("connection", "close");
                        
                        var modifiedResponseHeaders = httpVersion + " " + request.status + " " + request.statusText + "\r\n";
                        responseHeaders.forEach(function(value, key)
                        {
                            modifiedResponseHeaders += key + ": " + value + "\r\n";
                        });
                        modifiedResponseHeaders += "\r\n";
                        
                        var headersBuffer = asciiToBuffer(modifiedResponseHeaders);
                        var finalResponseBuffer = new Uint8Array(headersBuffer.length + responseBuffer.length);
                        finalResponseBuffer.set(headersBuffer, 0);
                        finalResponseBuffer.set(responseBuffer, headersBuffer.length);
                        g_vmm.queuePacket_ProxyConnectionSend(connection, finalResponseBuffer);
                        g_vmm.queuePacket_ProxyConnectionDisconnected(connection);
                    }
                    catch (err)
                    {
                        vmm.sendExceptionInfoRequest(connection, err.message, err.stack);
                    }
                }
            };
            request.onerror = function(e)
            {
                var additionalInfo = request.status == 0 ? " (check your browser console log, likely a CORS issue)" : "";
                vmm.sendExceptionInfoRequest(connection, "statusCode: " + request.status + " statusText: " + request.statusText + additionalInfo);
            };
            request.open(httpRequestType, "//" + host + httpRequestedPath, true);
            request.send(httpRequestPostBuffer);
        }
        catch (err)
        {
            this.sendExceptionInfoRequest(connection, err.message, err.stack);
        }
    }
};

function escapeStringForHtml(text)
{
    // https://stackoverflow.com/questions/1787322/htmlspecialchars-equivalent-in-javascript/4835406#4835406
    var map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

VMM.prototype.sendBadHttpRequest = function(connection)
{
    var str = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\n\r\n<html><head><title>400 Bad Request</title></head><body><div align=\"center\"><table border=\"0\" cellspacing=\"3\" cellpadding=\"3\" bgcolor=\"#C0C0C0\"><tr><td><table border=\"0\" width=\"500\" cellspacing=\"3\" cellpadding=\"3\"><tr><td bgcolor=\"#B2B2B2\"><p align=\"center\"><strong><font size=\"2\" face=\"Verdana\">400 Bad Request</font></strong></p></td></tr><tr><td bgcolor=\"#D1D1D1\"><font size=\"2\" face=\"Verdana\"> The proxy server could not understand the HTTP request!<br><br> Please contact your network administrator about this problem.</font></td></tr></table></center></td></tr></table></div></body></html>";
    var sendBuffer = asciiToBuffer(str);
    g_vmm.queuePacket_ProxyConnectionSend(connection, sendBuffer);
    g_vmm.queuePacket_ProxyConnectionDisconnected(connection);
};

VMM.prototype.sendHttpExceptionInfo = function(connection, error, stack)
{
    error = escapeStringForHtml("" + error);
    stack = escapeStringForHtml("" + stack);
    var str = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\n\r\n<html><head><title>500 Internal Server Error</title></head><body><div align=\"center\"><table border=\"0\" cellspacing=\"3\" cellpadding=\"3\" bgcolor=\"#C0C0C0\"><tr><td><table border=\"0\" width=\"500\" cellspacing=\"3\" cellpadding=\"3\"><tr><td bgcolor=\"#B2B2B2\"><p align=\"center\"><strong><font size=\"2\" face=\"Verdana\">500 Internal Server Error</font></strong></p></td></tr><tr><td bgcolor=\"#D1D1D1\"><font size=\"2\" face=\"Verdana\">An exception occured whilst sending the request.<br><br>" + error + "<br><br>Stack:<br><br>" + stack + "</font></td></tr></table></center></td></tr></table></div></body></html>";
    var sendBuffer = asciiToBuffer(str);
    g_vmm.queuePacket_ProxyConnectionSend(connection, sendBuffer);
    g_vmm.queuePacket_ProxyConnectionDisconnected(connection);
};

VMM.prototype.sendHttpContentMoved = function(connection, location)
{
    var str = "HTTP/1.1 301 301 Moved Permanently\r\nConnection: close\r\nLocation: " + location + "\r\nContent-Type: text/html\r\n\r\n<html><head><title>301 Moved Permanently</title></head><body>\n<h1>Moved Permanently</h1><p>The document has moved <a href=\"" + location + "\">here</a>.</p><hr></body></html>";
    var sendBuffer = asciiToBuffer(str);
    g_vmm.queuePacket_ProxyConnectionSend(connection, sendBuffer);
    g_vmm.queuePacket_ProxyConnectionDisconnected(connection);
};

VMM.prototype.processNetworkPacket = function(packetData)
{
    var buffer = packetData.Buffer;
    var networkType = buffer[0];
    var networkPacketType = buffer[1];
    switch (networkType)
    {
        case NT_DnsProxy:
            {
                var buffer = packetData.Buffer;
                switch (networkPacketType)
                {
                    case PROXY_RECV_UDP:
                        {
                            var recvBuffer = buffer.slice(2);
                            var url = (g_useSecureWebSockets ? "wss://" : "ws://") + "localhost:" + g_webSocketDnsPort;
                            var socket = new WebSocket(url);
                            socket.binaryType = "arraybuffer";
                            socket.onopen = function(e)
                            {
                                try
                                {
                                    socket.send(recvBuffer.buffer);
                                }
                                catch (err)
                                {
                                    console.log("UDP socket.send() failed: " + err);
                                }
                            };
                            socket.onmessage = function(e)
                            {
                                if (e.data instanceof ArrayBuffer)
                                {
                                    var sendBuffer = new Uint8Array(e.data);
                                    g_vmm.queuePacket_ProxyConnectionSendUdp(networkType, sendBuffer);
                                }
                                try
                                {
                                    socket.close();
                                }
                                catch (err)
                                {
                                    console.log("UDP socket.close() failed: " + err);
                                }
                            };
                        }
                        break;
                    default:
                        {
                            console.log("Unhandled UDP proxy packet type " + buffer[0]);
                        }
                        break;
                }
            }
            break;
        case NT_HttpsProxyEmulated:
            {
                // TODO (requires an implementation of TSL/SSL in javascript - https://github.com/digitalbazaar/forge)
            }
            break;
        case NT_HttpProxyEmulated:
            {
                var buffer = packetData.Buffer;
                var bufferDataView = new DataView(buffer.buffer);
                var connectionIndex = bufferDataView.getUint32(2, true);
                var connectionSocket = bufferDataView.getUint32(6, true);
                var connection = null;
                switch (networkPacketType)
                {
                    case PROXY_CONNECT:
                        {
                            connection = {};
                            connection.NetworkType = networkType;
                            connection.Index = connectionIndex;
                            connection.Socket = connectionSocket;
                            connection.IsClosed = false;
                            connection.WebSocket = null;
                            connection.HttpQuery = "";
                            connection.HttpRequestType = "";
                            connection.RequestedPath = "";
                            connection.HttpVersion = "";
                            connection.HeaderFields = null;// Map
                            connection.HttpRequestBuffer = [];// Treat as Uint8Array
                            connection.HttpPostBuffer = null;// Uint8Array
                            this.proxyConnections[connectionIndex] = connection;
                        }
                        break;
                    case PROXY_DISCONNECT:
                        {
                            connection = this.proxyConnections[connectionIndex];
                            if (connection != null && connection.Socket == connectionSocket && !connection.IsClosed)
                            {
                                connection.IsClosed = true;
                                delete this.proxyConnections[connectionIndex];
                            }
                        }
                        break;
                    case PROXY_RECV:
                        {
                            connection = this.proxyConnections[connectionIndex];
                            if (connection != null && connection.Socket == connectionSocket)
                            {
                                var recvBuffer = buffer.slice(10);
                                var str = bufferToAscii(recvBuffer);
                                connection.HttpQuery += str;
                                Array.prototype.push.apply(connection.HttpRequestBuffer, Array.from(recvBuffer));
                                if (this.isValidHttpQuery(connection, connection.HttpQuery))
                                {
                                    this.processHttpQuery(connection, connection.HttpQuery);
                                }
                            }
                        }
                        break;
                    default:
                        {
                            console.log("Unhandled proxy packet type " + networkPacketType);
                        }
                        break;
                }
            }
            break;
        case NT_HttpProxy:
        case NT_HttpsProxy:
        case NT_SocksProxy:
            {
                var buffer = packetData.Buffer;
                var bufferDataView = new DataView(buffer.buffer);
                var connectionIndex = bufferDataView.getUint32(2, true);
                var connectionSocket = bufferDataView.getUint32(6, true);
                var connection = null;
                switch (networkPacketType)
                {
                    case PROXY_CONNECT:
                        {
                            var port = 0;
                            switch (networkType)
                            {
                                case NT_SocksProxy:
                                    port = g_webSocketPort;
                                    break;
                                case NT_HttpProxy:
                                    port = g_webSocketHttpPort;
                                    break;
                                case NT_HttpsProxy:
                                    port = g_webSocketHttpsPort;
                                    break;
                                default:
                                    console.error("WebSocket server port not provided for network " + networkType);
                                    break;
                            }
                            connection = {};
                            var url = (g_useSecureWebSockets ? "wss://" : "ws://") + "localhost:" + port;
                            connection.NetworkType = networkType;
                            connection.Index = connectionIndex;
                            connection.Socket = connectionSocket;
                            connection.IsClosed = false;
                            connection.QueuedPackets = [];// Queue packets which are sent before fully connected
                            connection.WebSocket = new WebSocket(url);
                            connection.WebSocket.binaryType = "arraybuffer";
                            this.proxyConnections[connectionIndex] = connection;
                            connection.WebSocket.onerror = function(e)
                            {
                                var con = g_vmm.proxyConnections[connectionIndex];
                                if (con != null && !con.IsClosed && con.Index == connectionIndex &&
                                    con.Socket == connectionSocket && e.data instanceof ArrayBuffer)
                                {
                                    // TODO: Log error?
                                }
                            };
                            connection.WebSocket.onmessage = function(e)
                            {
                                var con = g_vmm.proxyConnections[connectionIndex];
                                if (con != null && !con.IsClosed && con.Index == connectionIndex &&
                                    con.Socket == connectionSocket && e.data instanceof ArrayBuffer)
                                {
                                    var sendBuffer = new Uint8Array(e.data);
                                    g_vmm.queuePacket_ProxyConnectionSend(con, sendBuffer);
                                }
                            };
                            connection.WebSocket.onclose = function(e)
                            {
                                var con = g_vmm.proxyConnections[connectionIndex];
                                if (con != null && !con.IsClosed && con.Index == connectionIndex &&
                                    con.Socket == connectionSocket)
                                {
                                    g_vmm.queuePacket_ProxyConnectionDisconnected(con);
                                    con.IsClosed = true;
                                    delete g_vmm.proxyConnections[connectionIndex];
                                }
                            };
                            connection.WebSocket.onopen = function(e)
                            {
                                var con = g_vmm.proxyConnections[connectionIndex];
                                if (con != null && !con.IsClosed && con.Index == connectionIndex &&
                                    con.Socket == connectionSocket)
                                {
                                    if (con.QueuedPackets.length > 0)
                                    {
                                        for (var i = 0; i < con.QueuedPackets.length; i++)
                                        {
                                            con.WebSocket.send(con.QueuedPackets[i].buffer);
                                        }
                                        con.QueuedPackets.length = 0;
                                    }
                                }
                            };
                        }
                        break;
                    case PROXY_DISCONNECT:
                        {
                            connection = this.proxyConnections[connectionIndex];
                            if (connection != null && connection.Socket == connectionSocket && !connection.IsClosed)
                            {
                                try
                                {
                                    connection.WebSocket.close();
                                }
                                catch (err)
                                {
                                    console.log("WebSocket.close() failed: " + err);
                                }
                                connection.IsClosed = true;
                                delete this.proxyConnections[connectionIndex];
                            }
                        }
                        break;
                    case PROXY_RECV:
                        {
                            connection = this.proxyConnections[connectionIndex];
                            if (connection != null && connection.Socket == connectionSocket)
                            {
                                var recvBuffer = buffer.slice(10);
                                if (connection.WebSocket.readyState == 1)// OPEN
                                {
                                    try
                                    {
                                        connection.WebSocket.send(recvBuffer.buffer);
                                    }
                                    catch (err)
                                    {
                                        console.log("WebSocket.send() failed: " + err);
                                    }
                                }
                                else if (connection.WebSocket.readyState == 0)// CONNECTING
                                {
                                    connection.QueuedPackets.push(recvBuffer);
                                }
                            }
                        }
                        break;
                    default:
                        {
                            console.log("Unhandled proxy packet type " + networkPacketType);
                        }
                        break;
                }
            }
            break;
    }
};

VMM.prototype.processClipboardPacket = function(packetData)
{
    var buffer = packetData.Buffer;
    if (buffer[1] == 0)
    {
        // Set clipboard data (response)
    }
    else if (buffer[1] == 1)
    {
        // Get clipboard data (response)
        switch (buffer[2])
        {
            case 0:// Text
                {
                    var text = bufferToUtf16(buffer.slice(3, buffer.length).buffer);
                    //console.log(buffer);
                    //console.log("'" + text + "'");
                    var setClipboard = false;
                    if (typeof(navigator) !== "undefined" && navigator.clipboard != null)
                    {
                        try
                        {
                            navigator.clipboard.writeText(text);
                            setClipboard = true;
                        }
                        catch (err)
                        {
                            console.log("Failed to set clipboard text '" + text + "'");
                        }
                    }
                    if (setClipboard)
                    {
                        getClipboardTb.value = "getCB";
                    }
                    else
                    {
                        this.clipboardData = text;
                        this.hasClipboardData = true;
                        getClipboardTb.value = "OK";
                    }
                }
                break;
            // No easy way to copy images to the clipboard?
            /*case 1:// Image
                {
                    var width = (new Uint32Array(buffer.slice(3, 7).buffer))[0];
                    var height = (new Uint32Array(buffer.slice(7, 11).buffer))[0];
                    console.log(buffer.slice(3, buffer.length));
                }
                break;*/
        }
    }
};

VMM.prototype.onBeginFileTransfer = function()
{
    downloadFileBtn.innerHTML = "cancel";
    uploadFileBtn.innerHTML = "cancel";
};

VMM.prototype.resetFileTransfer = function()
{
    this.fileTransfer.Files.length = 0;
    this.fileTransfer.CurrentFileIndex = -1;
    this.fileTransfer.Direction = -1;
    this.fileTransfer.BaseDirectory = null;
    
    downloadFileBtn.innerHTML = "download";
    uploadFileBtn.innerHTML = "upload";
};

VMM.prototype.saveFile = function(fileName, fileBuffer)
{
    var blob = new Blob([fileBuffer], {type: "application/octet-stream"});
    if (window.navigator.msSaveOrOpenBlob)
    {
        window.navigator.msSaveBlob(blob, fileName);
    }
    else
    {
        var elem = window.document.createElement('a');
        elem.href = window.URL.createObjectURL(blob);
        elem.download = fileName;
        document.body.appendChild(elem);
        elem.click();
        document.body.removeChild(elem);
    }
};

VMM.prototype.processFilePacket = function(packetData)
{
    var buffer = packetData.Buffer;
    switch (buffer[0])
    {
        case FT_VM_TO_HOST:
            {
                if (buffer[1] == 0)
                {
                    // Failed to start a file transfer
                    this.resetFileTransfer();
                }
                else if (this.fileTransfer.Direction != FT_VM_TO_HOST)
                {
                    // The state is messed up.
                    this.queuePacket_GetFilesFromVMCancel();
                }
            }
            break;
        case FT_HOST_TO_VM:
            {
                if (buffer[1] == 0)
                {
                    // Failed to start a file transfer
                    this.resetFileTransfer();
                }
                else if (this.fileTransfer.Direction != FT_HOST_TO_VM)
                {
                    // The state is messed up.
                    this.queuePacket_SendFilesToVMEnd(true);
                }
            }
            break;
        case FT_DATA:
            {
                if (this.fileTransfer.Direction != FT_VM_TO_HOST)
                {
                    return;
                }
            
                var fileInfo = null;
            
                var dv = new DataView(buffer.buffer);
                var pOffset = 1;
                var offset = dv.getUint32(pOffset, true);
                pOffset += 4;
                var length = dv.getUint32(pOffset, true);
                pOffset += 4;
                if (offset == 0)
                {
                    var isDirectory = dv.getUint8(pOffset, true) != 0;
                    pOffset += 1;
                    var pathLen = dv.getInt32(pOffset, true);
                    var path = "";
                    pOffset += 4;
                    for (var i = 0; i < pathLen; i++)
                    {
                        path += String.fromCharCode(dv.getUint16(pOffset, true));
                        pOffset += 2;
                    }
                    path = path.split("\\").join("/");// Normalize the path
                    if (this.fileTransfer.BaseDirectory == null && path.length > 0)
                    {
                        this.fileTransfer.BaseDirectory = path.substring(0, path.lastIndexOf("/") + 1);
                    }
                    if (this.fileTransfer.BaseDirectory != null)
                    {
                        path = path.substring(this.fileTransfer.BaseDirectory.length);
                    }
                    if (isDirectory)
                    {
                        console.log("transfer folder" + " '" + path + "'");
                    }
                    else
                    {
                        console.log("transfer file" + " '" + path + "' size: " + length);
                    }
                    
                    fileInfo = {};
                    fileInfo.IsDirectory = isDirectory;
                    fileInfo.Path = path;
                    fileInfo.Data = isDirectory ? null : new Uint8Array(length);
                    this.fileTransfer.Files.push(fileInfo);
                }
                else
                {
                    fileInfo = this.fileTransfer.Files[this.fileTransfer.Files.length - 1];
                }
                
                if (fileInfo == null)
                {
                    // File transfer cancelled?
                    return;
                }
                
                var dataSize = dv.getInt32(pOffset, true);
                pOffset += 4;
                if (dataSize > 0)
                {
                    fileInfo.Data.set(buffer.slice(pOffset, pOffset + dataSize), offset);
                }
                
                var isComplete = offset + dataSize >= length;
                if (isComplete)
                {
                    //console.log("File complete");
                }
            }
            break;
        case FT_END:
            {
                if (this.fileTransfer.Direction == FT_VM_TO_HOST)
                {
                    if (buffer[1] == 1)
                    {
                        console.log("Transfer cancelled");
                    }
                    else
                    {
                        // Zip up the the transferred files and save them to disk.
                        if (USE_ZIP && isJSZipLoaded())
                        {
                            var fileOwner = this;
                            var zip = new JSZip();
                            for (var i = 0; i < this.fileTransfer.Files.length; i++)
                            {
                                var fileInfo = this.fileTransfer.Files[i];
                                if (fileInfo.IsDirectory)
                                {
                                    zip.folder(fileInfo.Path);
                                }
                                else
                                {
                                    zip.file(fileInfo.Path, fileInfo.Data);
                                }
                            }
                            var content = zip.generate({type:"uint8array"});
                            fileOwner.saveFile(SHARED_FOLDER_NAME + ".zip", content);
                        }
                        else if (!USE_ZIP && isTarballJsLoaded())
                        {
                            var fileOwner = this;
                            var tar = new tarball.TarWriter();
                            for (var i = 0; i < this.fileTransfer.Files.length; i++)
                            {
                                var fileInfo = this.fileTransfer.Files[i];
                                if (fileInfo.IsDirectory)
                                {
                                    tar.addFolder(fileInfo.Path);
                                }
                                else
                                {
                                    tar.addFileArrayBuffer(fileInfo.Path, fileInfo.Data);
                                }
                            }
                            tar.download(SHARED_FOLDER_NAME + ".tar");
                        }
                        else
                        {
                            console.log("Failed to save files. File archive lib isn't loaded.");
                        }
                        
                        console.log("Transfer complete");
                    }
                }
                else if (this.fileTransfer.Direction == FT_HOST_TO_VM)
                {
                    //console.log("Transfer cancelled");
                }
                this.resetFileTransfer();
            }
            break;
    }
};

VMM.prototype.processPacket = function(packetType, packetData)
{
    switch (packetType)
    {
        case PT_MiscData:
            switch (packetData.Buffer[0])
            {
                case MP_Clipboard:
                    this.processClipboardPacket(packetData);
                    break;
                case MP_KeepAlive:
                    this.lastKeepAlive = performance.now();
                    break;
            }
            break;
		case PT_FileData:
			this.processFilePacket(packetData);
			break;
        case PT_NetworkData:
            this.processNetworkPacket(packetData);
            break;
    }
};

VMM.prototype.queuePacket = function(packetType, buffer)
{
    if (this.connectionState != g_conStateFullyConnected)
    {
        return;
    }
    if (buffer == null || buffer.length == 0 || packetType < 0 || packetType >= PT_MAX)
    {
        return;
    }
    var packetData = {};
    packetData.Buffer = buffer;
    packetData.Offset = 0;
    packetData.Length = buffer.length;
    packetData.Cancel = 0;
    packetData.Next = null;
    
    var item = this.packetWriters[packetType];
    if (item != null)
    {
        var count = 0;
        while (item.Next != null)
        {
            item = item.Next;
            count++;
            if (count > this.MAX_QUEUED_PACKETS)
            {
                this.setDisconnected();
                console.log("Queued packets reached limit for packet type " + packetType);
                return;
            }
        }
        item.Next = packetData;
    }
    else
    {
        this.packetWriters[packetType] = packetData;
    }
};

VMM.prototype.queuePacket_KeepAlive = function()
{
    var buffer = new Uint8Array(1);
    buffer[0] = MP_KeepAlive;
    this.queuePacket(PT_MiscData, buffer);
};

VMM.prototype.queuePacket_GetClipboardData = function()
{
    var buffer = new Uint8Array(2);
    buffer[0] = MP_Clipboard;
    buffer[1] = 1;// Get clipboard data
    this.queuePacket(PT_MiscData, buffer);
};

VMM.prototype.queuePacket_SetClipboardText = function(text)
{
    var textBuffer = new Uint8Array(utf16ToBuffer(text));
    var buffer = new Uint8Array(textBuffer.length + 3 + 2);// Include a null terminator
    buffer[0] = MP_Clipboard;
    buffer[1] = 0;// Set clipboard data
    buffer[2] = 0;// Text data type
    buffer.set(textBuffer, 3);
    this.queuePacket(PT_MiscData, buffer);
};

VMM.prototype.queuePacket_SendFilesToVM = function()
{
    var buffer = new Uint8Array(1);
    buffer[0] = FT_HOST_TO_VM;
    this.queuePacket(PT_FileData, buffer);
};

VMM.prototype.queuePacket_SendFilesToVMEnd = function(isCancel)
{
    var buffer = new Uint8Array(1);
    buffer[0] = FT_END;
    buffer[1] = isCancel ? 1 : 0;
    this.queuePacket(PT_FileData, buffer);
};

VMM.prototype.queuePacket_SendFilesToVMData = function(item)
{
    var headerLen = 0;
    var pathLen = 0;
    if (item.Offset == 0)
    {
        pathLen = item.Path.length;
        headerLen = (1+4+4+1+4+(pathLen*2)+4);
    }
    else
    {
        headerLen = (1+4+4+4);
    }
    var dataSize = Math.min(item.Length - item.Offset, this.PACKET_BLOCK_DATA_SIZE - headerLen);
   
    var buffer = new Uint8Array(dataSize + headerLen);
    var dv = new DataView(buffer.buffer);
    var pOffset = 0;
   
    dv.setUint8(pOffset, FT_DATA, true);
    pOffset += 1;
    dv.setUint32(pOffset, item.Offset, true);
    pOffset += 4;
    dv.setUint32(pOffset, item.Length, true);
    pOffset += 4;
   
    if (item.Offset == 0)
    {
        dv.setUint8(pOffset, item.IsDirectory ? 1 : 0, true);
        pOffset += 1;
        dv.setUint32(pOffset, pathLen, true);
        pOffset += 4;
        var pathBuffer = new Uint8Array(utf16ToBuffer(item.Path));
        buffer.set(pathBuffer, pOffset);
        pOffset += pathBuffer.length;
    }
    
    dv.setUint32(pOffset, dataSize, true);
    pOffset += 4;
    
    if (item.Data != null)
    {
        buffer.set(item.Data.slice(item.Offset, item.Offset + dataSize), pOffset);
        item.Offset += dataSize;
    }
    this.queuePacket(PT_FileData, buffer);
};

VMM.prototype.queuePacket_SendFilesToVMDataNext = function()
{
    if (this.fileTransfer.Direction != FT_HOST_TO_VM)
    {
       return; 
    }
    if (this.fileTransfer.CurrentFileIndex < this.fileTransfer.Files.length)
    {
        var item = this.fileTransfer.Files[this.fileTransfer.CurrentFileIndex];
        if (item.Offset == 0)
        {
            if (item.IsDirectory)
            {
                console.log("transfer folder" + " '" + item.Path + "'");
            }
            else
            {
                console.log("transfer file" + " '" + item.Path + "' size: " + item.Length);
            }
        }
        if (!item.HasOpenedFile)
        {
            item.FileReader.onload = function(e)
            {
                if (g_vmm.fileTransfer.Direction == FT_HOST_TO_VM)
                {
                    item.HasOpenedFile = true;
                    item.Data = new Uint8Array(item.FileReader.result);
                    item.Length = item.Data.length;
                    var skip = false;
                    var dotIndex = -1;
                    if (g_vmm.fileTransfer.Files.length == 1 && AUTO_EXTRACT_ARCHIVES &&
                        (dotIndex = item.Path.lastIndexOf(".")) > 0)
                    {
                        var rootFolderName = item.Path.substring(0, dotIndex) + "\\";
                        switch (item.Path.split(".").pop().toLowerCase())
                        {
                            case "tar":
                                if (isTarballJsLoaded())
                                {
                                    skip = true;
                                    var tar = new tarball.TarReader();
                                    tar.readArrayBuffer(item.Data.buffer).then(function(files)
                                    {
                                        if (g_vmm.fileTransfer.Direction != FT_HOST_TO_VM)
                                        {
                                            return;
                                        }
                                    
                                        for (var i = 0; i < files.length; i++)
                                        {
                                            var file = files[i];
                                            
                                            var fileInfo = {};
                                            fileInfo.HasOpenedFile = true;
                                            fileInfo.File = null;
                                            fileInfo.Path = rootFolderName + file.name;
                                            fileInfo.IsDirectory = file.type == "directory";
                                            fileInfo.Offset = 0;
                                            fileInfo.Length = fileInfo.IsDirectory ? 0 : file.size;
                                            if (file.size > 0)
                                            {
                                                fileInfo.Data = new Uint8Array(tar.buffer, file.header_offset+512, file.size);
                                            }
                                            else
                                            {
                                                fileInfo.Data = null;
                                            }
                                            g_vmm.fileTransfer.Files.push(fileInfo);
                                        }
                                        g_vmm.fileTransfer.CurrentFileIndex++;
                                        g_vmm.queuePacket_SendFilesToVMDataNext();
                                    });
                                }
                                break;
                            case "zip":
                                if (isJSZipLoaded())
                                {
                                    skip = true;
                                    var zip = new JSZip();
                                    zip.load(item.Data);
                                    for (var fileKey in zip.files)
                                    {
                                        var file = zip.files[fileKey];
                                        var fileInfo = {};
                                        fileInfo.HasOpenedFile = true;
                                        fileInfo.File = null;
                                        fileInfo.Path = rootFolderName + file.name;
                                        fileInfo.IsDirectory = file.dir ? true : false;// bool? string?
                                        fileInfo.Data = fileInfo.IsDirectory ? null : file.asUint8Array();
                                        fileInfo.Offset = 0;
                                        fileInfo.Length = fileInfo.IsDirectory ? 0 : fileInfo.Data.length;
                                        g_vmm.fileTransfer.Files.push(fileInfo);
                                    }
                                    g_vmm.fileTransfer.CurrentFileIndex++;
                                    g_vmm.queuePacket_SendFilesToVMDataNext();
                                }
                                break;
                        }
                    }
                    if (!skip)
                    {
                        g_vmm.queuePacket_SendFilesToVMData(item);
                        if (item.Offset >= item.Length)
                        {
                            g_vmm.fileTransfer.CurrentFileIndex++;
                            item.Data = null;
                        }
                    }
                }
            };
            item.error = function(e)
            {
                g_vmm.fileTransfer.CurrentFileIndex++;
                g_vmm.queuePacket_SendFilesToVMDataNext();
            };
            item.FileReader.readAsArrayBuffer(item.File);
        }
        else
        {
            this.queuePacket_SendFilesToVMData(item);
            if (item.Offset >= item.Length)
            {
                this.fileTransfer.CurrentFileIndex++;
                item.Data = null;
            }
        }
    }
    else if (this.fileTransfer.CurrentFileIndex >= this.fileTransfer.Files.length)
    {
        this.queuePacket_SendFilesToVMEnd(false);
        this.resetFileTransfer();
        console.log("Transfer complete");
    }
};

VMM.prototype.queuePacket_GetFilesFromVM = function()
{
    var buffer = new Uint8Array(1);
    buffer[0] = FT_VM_TO_HOST;
    this.queuePacket(PT_FileData, buffer);
};

VMM.prototype.queuePacket_GetFilesFromVMCancel = function()
{
    var buffer = new Uint8Array(1);
    buffer[0] = FT_END;
    buffer[1] = 1;// Cancel
    this.queuePacket(PT_FileData, buffer);
};

VMM.prototype.queuePacket_NetworkPacket = function(connection, networkType, networkPacketType, buffer)
{
    var totalBufferLen = (buffer == null ? 0 : buffer.length) + 2;
    if (connection != null)
    {
        totalBufferLen += 4 + 4;
    }
    var totalBuffer = new Uint8Array(totalBufferLen);
    var dv = new DataView(totalBuffer.buffer);
    var offset = 0;
    dv.setUint8(offset, networkType, true);
    offset += 1;
    dv.setUint8(offset, networkPacketType, true);
    offset += 1;
    if (connection != null)
    {
        dv.setUint32(offset, connection.Index, true);
        offset += 4;
        dv.setUint32(offset, connection.Socket, true);
        offset += 4;
    }
    if (buffer != null)
    {
        totalBuffer.set(buffer, offset);
        offset += buffer.length;
    }
    this.queuePacket(PT_NetworkData, totalBuffer);
};

VMM.prototype.queuePacket_ProxyConnectionSend = function(connection, buffer)
{
    this.queuePacket_NetworkPacket(connection, connection.NetworkType, PROXY_SEND, buffer);
};

VMM.prototype.queuePacket_ProxyConnectionDisconnected = function(connection)
{
    this.queuePacket_NetworkPacket(connection, connection.NetworkType, PROXY_DISCONNECT, null);
};

VMM.prototype.queuePacket_ProxyConnectionSendUdp = function(networkType, buffer)
{
    this.queuePacket_NetworkPacket(null, networkType, PROXY_SEND_UDP, buffer);
};

VMM.prototype.processPackets = function()
{
    var processedData = false;
    for (var i = 0; i < PT_MAX; i++)
    {
        var packetType = i;
        // Reader/writer need to be opposite of vmtools.c
        var readerOffset = this.packetOffsets[(i * 2) + 1];
        var writerOffset = this.packetOffsets[(i * 2) + 0];
        var queuedReaders = this.readU32(this.memoryBlocks, readerOffset);
        var queuedWriters = this.readU32(this.memoryBlocks, writerOffset);
        
        if (queuedReaders > 0)
        {
            var pOffset = 0;
            for (var j = 0; j < queuedReaders; j++)
            {
                var cancel = this.readU8(this.memoryBlocks, readerOffset + pOffset + 4);
                var offset = this.readU32(this.memoryBlocks, readerOffset + pOffset + 5);
                var totalLen = this.readU32(this.memoryBlocks, readerOffset + pOffset + 9);
                var chunkLen = this.readU32(this.memoryBlocks, readerOffset + pOffset + 13);
                var isComplete = offset + chunkLen >= totalLen;
                if (cancel)
                {
                    var packetData = this.packetReaders[i];
                    if (packetData != null)
                    {
                        console.assert(packetReaders[i].Next == null);
                        packetReaders[i] = null;
                    }
                }
                else if (totalLen > 0)
                {
                    var packetData = this.packetReaders[i];
                    if (offset == 0)
                    {
                        console.assert(packetData == null);
                        packetData = {};
                        packetData.Buffer = new Uint8Array(totalLen);
                        packetData.Offset = 0;
                        packetData.Length = totalLen;
                        packetData.Cancel = 0;
                        packetData.Next = null;
                        this.packetReaders[i] = packetData;
                    }
                    if (packetData != null)
                    {
                        console.assert(packetData.Next == null);
                        console.assert(offset + chunkLen <= packetData.Length);
                        packetData.Offset = offset;
                        var buffer = this.readBytes(this.memoryBlocks, readerOffset + pOffset + this.PACKET_BLOCK_HEADER_SIZE, chunkLen);
                        packetData.Buffer.set(buffer, packetData.Offset);
                        if (isComplete)
                        {
                            this.processPacket(packetType, packetData);
                            this.packetReaders[i] = null;
                        }
                    }
                }
                pOffset += this.PACKET_BLOCK_HEADER_SIZE + chunkLen;
            }
            this.writeU32(this.memoryBlocks, readerOffset, 0);
            processedData = true;
        }
        if (queuedWriters == 0)
        {
            var packetData = this.packetWriters[i];
            if (packetData != null)
            {
                var pOffset = 0;
                while (pOffset < this.PACKET_BLOCK_SIZE && packetData != null)
                {
                    if (pOffset != 0 && packetData.Length + this.PACKET_BLOCK_HEADER_SIZE >= this.PACKET_BLOCK_SIZE - pOffset)
                    {
                        break;
                    }
                
                    var chunkLen = Math.min(packetData.Length - packetData.Offset, this.PACKET_BLOCK_DATA_SIZE);
                    var buffer = packetData.Buffer.slice(packetData.Offset, packetData.Offset + chunkLen);
                    
                    this.writeU8(this.memoryBlocks, writerOffset + pOffset + 4, packetData.Cancel);
                    this.writeU32(this.memoryBlocks, writerOffset + pOffset + 5, packetData.Offset);
                    this.writeU32(this.memoryBlocks, writerOffset + pOffset + 9, packetData.Length);
                    this.writeU32(this.memoryBlocks, writerOffset + pOffset + 13, chunkLen);
                    this.writeBytes(this.memoryBlocks, writerOffset + pOffset + this.PACKET_BLOCK_HEADER_SIZE, buffer);
                    
                    packetData.Offset += chunkLen;
                    if (packetData.Offset >= packetData.Length)
                    {
                        this.packetWriters[i] = packetData.Next;
                        switch (packetType)
                        {
                            case PT_FileData:
                                {
                                    if (this.fileTransfer.Direction == FT_HOST_TO_VM && packetData.Buffer[0] == FT_DATA)
                                    {
                                        this.queuePacket_SendFilesToVMDataNext();
                                    }
                                }
                                break;
                        }
                    }
                    
                    pOffset += this.PACKET_BLOCK_HEADER_SIZE + chunkLen;
                    queuedWriters++;
                    packetData = this.packetWriters[i];
                }
                
                this.writeU32(this.memoryBlocks, writerOffset, queuedWriters);
                if (queuedWriters > 0)
                {
                    processedData = true;
                }
            }
        }
    }
    return processedData;
};

VMM.prototype.setDisconnected = function()
{
    if (this.memoryBlocks != null)
    {
        this.writeU32(this.memoryBlocks, 0, hostMagicDead);
        this.memoryBlocks = null;
        this.fileBlocks = null;
    }
    this.connectionState = g_conStateDisconnected;

    for (var i = 0; i < this.proxyConnections.length; i++)
    {
        var proxyConnection = this.proxyConnections[i];
        if (proxyConnection != null)
        {
            this.proxyConnections[i].IsClosed = true;
            var webSocket = this.proxyConnections[i].WebSocket;
            if (webSocket != null)
            {
                try
                {
                    webSocket.close();
                }
                catch (err)
                {
                }
            }
        }
    }
    this.proxyConnections.length = 0;
    
    this.clipboardData = "";
    this.hasClipboardData = false;
    
    this.resetFileTransfer();
    
    connectBtn.innerHTML = "connect";
};

VMM.prototype.watcherCycle = function()
{
	if (this.memoryBlocks != null)
	{
		if (this.connectionState == g_conStateConnecting)
		{
			var guestState = this.readU32(this.memoryBlocks, 4);
			if (guestState == guestMagicXfer)
			{
                console.log("guestMagicXfer");
				this.connectionState = g_conStateStubFileTransfer;
                if (this.toolsFileBuffer != null)
                {
                    this.writeBytes(this.memoryBlocks, 12, this.toolsFileBuffer);
                    this.writeU32(this.memoryBlocks, 8, this.toolsFileBuffer.length);
                    this.writeU32(this.memoryBlocks, 0, hostMagicXfer);
                }
                else
                {
                    this.setDisconnected();
                    console.log("Stub requested main tools exe, but it wasn't uploaded along with the stub.");
                }
			}
			else if (guestState == guestMagicComm)
			{
                console.log("guestMagicComm");
                this.initPacketOffsets();
                this.lastSendKeepAlive = this.lastKeepAlive = performance.now();
				this.connectionState = g_conStateFullyConnected;
				this.writeU32(this.memoryBlocks, 0, hostMagicComm);
                connectBtn.innerHTML = "disconnect";
			}
            else if (guestState == guestMagicDead)
            {
                this.setDisconnected();
                console.log("Disconnected from vmtools");
            }
            this.doWatcherCycle(200);
		}
        else if (this.connectionState == g_conStateStubFileTransfer)
        {
            var guestState = this.readU32(this.memoryBlocks, 4);
            if (guestState == guestMagicDead)
            {
                this.setDisconnected();
                console.log("Disconnected from stub");
                
                // Connect to the main tool
                connectToVM();
            }
            this.doWatcherCycle(200);
        }
        else if (this.connectionState == g_conStateFullyConnected)
        {
            var processedData = false;
            var guestState = this.readU32(this.memoryBlocks, 4);
            if (guestState == guestMagicDead)
            {
                this.setDisconnected();
                console.log("Disconnected from vmtools");
            }
            else
            {
                while (this.processPackets())
                {
                    processedData = true;
                }
            }
            
            var perfNow = performance.now();
            
            if (USE_KEEP_ALIVE)
            {
                if (this.lastKeepAlive + KEEP_ALIVE_TIMEOUT > this.lastKeepAlive &&
                    this.lastKeepAlive + KEEP_ALIVE_TIMEOUT < perfNow)
                {
                    this.setDisconnected();
                    console.log("KeepAlive timeout");
                }
                
                if (this.lastSendKeepAlive + KEEP_ALIVE_DELAY < this.lastSendKeepAlive ||
                    this.lastSendKeepAlive + KEEP_ALIVE_DELAY < perfNow)
                {
                    this.lastSendKeepAlive = perfNow;
                    this.queuePacket_KeepAlive();
                }
            }
            
            // This is probably a little heavy. Do something better here.
            if (processedData)
            {
                this.lastData = perfNow;
                this.doWatcherCycle(1);
            }
            else if (this.fileTransfer.Direction != -1 || perfNow < this.lastData + 100)
            {
                this.doWatcherCycle(1);
            }
            else
            {
                this.doWatcherCycle(100);
            }
        }
        else
        {
            this.doWatcherCycle(1000);
        }
	}
	else
	{
        this.doWatcherCycle(1000);
	}
};

VMM.prototype.doWatcherCycle = function(delay)
{
    var _this = this;
	setTimeout(function() { _this.watcherCycle(); }, delay);
};

g_vmm = new VMM();
g_vmm.doWatcherCycle(100);