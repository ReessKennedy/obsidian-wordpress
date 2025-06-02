import { Notice, TFile } from 'obsidian';
import WordpressPlugin from './main';
import {
  WordPressAuthParams,
  WordPressClient,
  WordPressClientResult,
  WordPressClientReturnCode,
  WordPressMediaUploadResult,
  WordPressPostParams,
  WordPressPublishResult
} from './wp-client';
import { WpPublishModal } from './wp-publish-modal';
import { PostType, PostTypeConst, Term } from './wp-api';
import { ERROR_NOTICE_TIMEOUT, WP_DEFAULT_PROFILE_NAME } from './consts';
import { isPromiseFulfilledResult, isValidUrl, openWithBrowser, processFile, SafeAny, showError, } from './utils';
import { WpProfile } from './wp-profile';
import { AppState } from './app-state';
import { ConfirmCode, openConfirmModal } from './confirm-modal';
import fileTypeChecker from 'file-type-checker';
import { MatterData, Media } from './types';
import { openPostPublishedModal } from './post-published-modal';
import { openLoginModal } from './wp-login-modal';
import { isFunction } from 'lodash-es';

export abstract class AbstractWordPressClient implements WordPressClient {

  /**
   * Client name.
   */
  name = 'AbstractWordPressClient';
  
  // Publish lock to prevent multiple simultaneous publishes
  private static publishInProgress = false;

  protected constructor(
    protected readonly plugin: WordpressPlugin,
    protected readonly profile: WpProfile
  ) { }

  abstract publish(
    title: string,
    content: string,
    postParams: WordPressPostParams,
    certificate: WordPressAuthParams
  ): Promise<WordPressClientResult<WordPressPublishResult>>;

  abstract getCategories(
    certificate: WordPressAuthParams
  ): Promise<Term[]>;

  abstract getPostTypes(
    certificate: WordPressAuthParams
  ): Promise<PostType[]>;

  abstract validateUser(
    certificate: WordPressAuthParams
  ): Promise<WordPressClientResult<boolean>>;

  abstract getTag(
    name: string,
    certificate: WordPressAuthParams
  ): Promise<Term>;

  abstract uploadMedia(
    media: Media,
    certificate: WordPressAuthParams
  ): Promise<WordPressClientResult<WordPressMediaUploadResult>>;

  protected needLogin(): boolean {
    return true;
  }

  private async getAuth(): Promise<WordPressAuthParams> {
    let auth: WordPressAuthParams = {
      username: null,
      password: null
    };
    try {
      if (this.needLogin()) {
        // Check if there's saved username and password
        if (this.profile.username && this.profile.password) {
          auth = {
            username: this.profile.username,
            password: this.profile.password
          };
          const authResult = await this.validateUser(auth);
          if (authResult.code !== WordPressClientReturnCode.OK) {
            throw new Error(this.plugin.i18n.t('error_invalidUser'));
          }
        }
      }
    } catch (error) {
      showError(error);
      const result = await openLoginModal(this.plugin, this.profile, async (auth) => {
        const authResult = await this.validateUser(auth);
        return authResult.code === WordPressClientReturnCode.OK;
      });
      auth = result.auth;
    }
    return auth;
  }

  /**
   * Extract post ID from WordPress URL
   * Handles various WordPress URL structures like:
   * - https://example.com/2023/06/01/post-slug/
   * - https://example.com/?p=123
   * - https://example.com/post-slug/
   */
  private async extractPostIdFromUrl(url: string): Promise<number | null> {
    try {
      const urlObj = new URL(url);
      
      // Check for ?p=ID parameter (direct post ID)
      const postIdParam = urlObj.searchParams.get('p');
      if (postIdParam) {
        return parseInt(postIdParam, 10);
      }
      
      // Extract slug from URL path
      const pathname = urlObj.pathname;
      const segments = pathname.split('/').filter(segment => segment.length > 0);
      
      if (segments.length === 0) {
        return null;
      }
      
      // Get the last segment as the slug (most common case)
      // Remove file extensions if present (e.g., .html, .php)
      let slug = segments[segments.length - 1];
      slug = slug.replace(/\.(html|php|htm)$/i, '');
      
      if (slug.length === 0) {
        return null;
      }
      
      // Look up post ID by slug using WordPress API
      return await this.getPostIdBySlug(slug);
    } catch (error) {
      console.error('Error parsing WordPress URL:', error);
      return null;
    }
  }

  /**
   * Get post ID from slug using WordPress REST API
   */
  private async getPostIdBySlug(slug: string): Promise<number | null> {
    try {
      // Use WordPress REST API to find post by slug
      const response = await this.getPostsBySlug(slug);
      if (response && response.length > 0) {
        return parseInt(response[0].id, 10);
      }
      return null;
    } catch (error) {
      console.error('Error getting post ID by slug:', error);
      return null;
    }
  }

  /**
   * Get posts by slug using REST API
   */
  protected async getPostsBySlug(slug: string): Promise<any[]> {
    // This will be implemented by the specific client (REST or XML-RPC)
    // For now, return empty array - subclasses should override this
    return [];
  }

  /**
   * Convert category names to IDs for API calls
   */
  private async convertCategoryNamesToIds(categoryNames: string[], auth: WordPressAuthParams): Promise<number[]> {
    try {
      const allCategories = await this.getCategories(auth);
      const categoryIds: number[] = [];
      const missingCategories: string[] = [];
      
      for (const name of categoryNames) {
        const category = allCategories.find(cat => cat.name.toLowerCase() === name.toLowerCase());
        if (category) {
          categoryIds.push(parseInt(category.id, 10));
        } else {
          missingCategories.push(name);
          console.warn(`Category not found: ${name}. Using default category (ID: 1).`);
          categoryIds.push(1); // Default to "Uncategorized" category
        }
      }
      
      // Show a notice if categories were missing
      if (missingCategories.length > 0) {
        new Notice(`Categories not found: ${missingCategories.join(', ')}. Using "Uncategorized" instead.`);
      }
      
      // Remove duplicates
      const uniqueIds = [...new Set(categoryIds)];
      return uniqueIds.length > 0 ? uniqueIds : [1];
    } catch (error) {
      console.error('Error converting category names to IDs:', error);
      return [1]; // Default to "Uncategorized" category
    }
  }

  /**
   * Convert category IDs to names for frontmatter storage
   */
  private async convertCategoryIdsToNames(categoryIds: number[], auth: WordPressAuthParams): Promise<string[]> {
    try {
      const allCategories = await this.getCategories(auth);
      const categoryNames: string[] = [];
      
      for (const id of categoryIds) {
        const category = allCategories.find(cat => parseInt(cat.id, 10) === id);
        if (category) {
          categoryNames.push(category.name);
        } else {
          console.warn(`Category ID not found: ${id}. Skipping.`);
        }
      }
      
      return categoryNames.length > 0 ? categoryNames : ['Uncategorized'];
    } catch (error) {
      console.error('Error converting category IDs to names:', error);
      return ['Uncategorized'];
    }
  }

  private async checkExistingProfile(matterData: MatterData) {
    const { wp_profile } = matterData;
    const isProfileNameMismatch = wp_profile && wp_profile !== this.profile.name;
    console.log('DEBUG: checkExistingProfile - wp_profile =', wp_profile, 'current profile =', this.profile.name, 'mismatch =', isProfileNameMismatch);
    if (isProfileNameMismatch) {
      console.log('DEBUG: Profile mismatch detected, showing confirm modal');
      const confirm = await openConfirmModal({
        message: this.plugin.i18n.t('error_profileNotMatch'),
        cancelText: this.plugin.i18n.t('profileNotMatch_useOld', {
          profileName: matterData.wp_profile
        }),
        confirmText: this.plugin.i18n.t('profileNotMatch_useNew', {
          profileName: this.profile.name
        })
      }, this.plugin);
      console.log('DEBUG: Confirm modal result =', confirm.code);
      if (confirm.code !== ConfirmCode.Cancel) {
        console.log('DEBUG: CLEARING wp_url due to profile change!');
        delete matterData.wp_url;
        // Set wp_categories to profile default (could be names or IDs)
        if (this.profile.lastSelectedCategories && this.profile.lastSelectedCategories.length > 0) {
          matterData.wp_categories = this.profile.lastSelectedCategories;
        } else {
          matterData.wp_categories = [1]; // Default to "Uncategorized" ID
        }
      }
    }
  }

  private async tryToPublish(params: {
    postParams: WordPressPostParams,
    auth: WordPressAuthParams,
    updateMatterData?: (matter: MatterData) => void,
    originalTagNames?: string[],
  }): Promise<WordPressClientResult<WordPressPublishResult>> {
    const { postParams, auth, updateMatterData, originalTagNames } = params;
    
    console.log('DEBUG: tryToPublish called with postParams:', JSON.stringify(postParams));
    
    const tagTerms = await this.getTags(postParams.tags, auth);
    postParams.tags = tagTerms.map(term => term.id);
    await this.updatePostImages({
      auth,
      postParams
    });
    const html = AppState.markdownParser.render(postParams.content);
    
    console.log('DEBUG: About to call this.publish with:');
    console.log('DEBUG: - title:', postParams.title);
    console.log('DEBUG: - content length:', postParams.content?.length || 0);
    console.log('DEBUG: - content preview:', postParams.content?.substring(0, 200));
    console.log('DEBUG: - html length:', html?.length || 0);
    console.log('DEBUG: - html preview:', html?.substring(0, 200));
    console.log('DEBUG: - postParams.postId:', postParams.postId);
    console.log('DEBUG: - this.name:', this.name);
    
    const result = await this.publish(
      postParams.title ?? 'A post from Obsidian!',
      html,
      postParams,
      auth);
    if (result.code === WordPressClientReturnCode.Error) {
      throw new Error(this.plugin.i18n.t('error_publishFailed', {
        code: result.error.code as string,
        message: result.error.message
      }));
    } else {
      new Notice(this.plugin.i18n.t('message_publishSuccessfully'));
      // post id will be returned if creating, true if editing
      const postId = result.data.postId;
      const file = this.plugin.app.workspace.getActiveFile();
      
      // Always update frontmatter, whether creating or updating
      if (file) {
        console.log('DEBUG: Before frontmatter update');
        console.log('DEBUG: postId =', postId);
        console.log('DEBUG: result.data.postUrl =', result.data.postUrl);
        console.log('DEBUG: postParams =', JSON.stringify(postParams));
        
        // Debug: Check frontmatter BEFORE processFrontMatter
        const currentContent = await this.plugin.app.vault.read(file);
        console.log('DEBUG: Full file content before processing:', currentContent.substring(0, 500));
        
        // Pre-convert category data before frontmatter processing
        let categoryNamesForNewPost: string[] | undefined;
        let categoryNamesForExisting: string[] | undefined;
        let categoryNamesForUpdate: string[] | undefined;
        
        // Convert new post categories to names if needed
        if (postParams.categories && postParams.categories.length > 0) {
          try {
            const auth = await this.getAuth();
            categoryNamesForNewPost = await this.convertCategoryIdsToNames(postParams.categories, auth);
            // Also use this as the update case conversion
            categoryNamesForUpdate = categoryNamesForNewPost;
          } catch (error) {
            console.warn('Could not convert category IDs to names for new post:', error);
          }
        }
        
        // Check if we need to convert existing categories from IDs to names
        const currentFileData = await processFile(file, this.plugin.app);
        if (currentFileData.matter.wp_categories && Array.isArray(currentFileData.matter.wp_categories) && currentFileData.matter.wp_categories.length > 0) {
          if (typeof currentFileData.matter.wp_categories[0] === 'number') {
            // Convert existing IDs to names
            try {
              const auth = await this.getAuth();
              categoryNamesForExisting = await this.convertCategoryIdsToNames(currentFileData.matter.wp_categories as number[], auth);
            } catch (error) {
              console.warn('Could not convert existing category IDs to names:', error);
            }
          }
        }
        
        await this.plugin.app.fileManager.processFrontMatter(file, fm => {
          console.log('DEBUG: Original frontmatter =', JSON.stringify(fm));
          
          // Store ALL original WordPress frontmatter to ensure preservation
          const preserved = {
            wp_url: fm.wp_url,
            wp_profile: fm.wp_profile,
            wp_ptype: fm.wp_ptype,
            wp_categories: fm.wp_categories,
            wp_tags: fm.wp_tags,
            wp_title: fm.wp_title
          };
          
          // Only update fields that should actually change
          fm.wp_profile = this.profile.name;
          
          // URL preservation logic - NEVER change existing URLs for updates
          if (preserved.wp_url) {
            // Always keep existing URL for updates - it's already valid
            fm.wp_url = preserved.wp_url;
            console.log('DEBUG: Keeping existing URL (never change for updates):', preserved.wp_url);
          } else if (result.data.postUrl) {
            // Only use response URL for completely new posts
            fm.wp_url = result.data.postUrl;
            console.log('DEBUG: Using postUrl for new post:', result.data.postUrl);
          } else if (postId) {
            // Fallback for new posts if no postUrl provided
            fm.wp_url = `${this.profile.endpoint}/?p=${postId}`;
            console.log('DEBUG: Creating fallback URL for new post:', fm.wp_url);
          }
          
          // Preserve other fields - never delete them
          if (preserved.wp_ptype !== undefined) {
            fm.wp_ptype = preserved.wp_ptype;
          } else if (postParams.postType) {
            fm.wp_ptype = postParams.postType; // Set for new posts
          }
          
          // Categories: Save as names instead of IDs
          // For updates, we should use the current categories from postParams (which come from frontmatter)
          // Only preserve existing categories if this is truly a preservation case (no new categories specified)
          if (categoryNamesForNewPost) {
            // Use pre-computed category names for new posts
            fm.wp_categories = categoryNamesForNewPost;
          } else if (categoryNamesForExisting) {
            // Use converted names for existing posts that had ID-based categories
            fm.wp_categories = categoryNamesForExisting;
          } else if (categoryNamesForUpdate) {
            // Update case: use pre-computed category names
            fm.wp_categories = categoryNamesForUpdate;
          } else if (postParams.categories && postParams.categories.length > 0) {
            // Fallback to IDs if conversion failed
            fm.wp_categories = postParams.categories;
          } else if (preserved.wp_categories !== undefined) {
            // Only preserve if no new categories were specified
            fm.wp_categories = preserved.wp_categories;
          }
          
          // Tags: Always use current tags from postParams for updates
          if (originalTagNames !== undefined && originalTagNames.length >= 0) {
            fm.wp_tags = originalTagNames; // Use original tag names (including empty array for clearing)
          } else if (postParams.tags !== undefined && postParams.tags.length >= 0) {
            fm.wp_tags = postParams.tags; // Use current tags (including empty array for clearing)
          } else if (preserved.wp_tags !== undefined) {
            fm.wp_tags = preserved.wp_tags; // Only preserve if no new tags specified
          }
          
          if (preserved.wp_title !== undefined) {
            fm.wp_title = preserved.wp_title;
          } else if (postParams.title && postParams.title !== file.basename) {
            fm.wp_title = postParams.title; // Set for new posts with custom title
          }
          
          console.log('DEBUG: Preserved values =', JSON.stringify(preserved));
          console.log('DEBUG: Final frontmatter =', JSON.stringify(fm));
          
          // Run any additional updates from modal, but after our preservation
          if (isFunction(updateMatterData)) {
            console.log('DEBUG: Running updateMatterData callback');
            updateMatterData(fm);
            console.log('DEBUG: After updateMatterData =', JSON.stringify(fm));
          }
        });
        
        console.log('DEBUG: Frontmatter update completed');
        
        // Debug: Check frontmatter AFTER processFrontMatter
        const updatedContent = await this.plugin.app.vault.read(file);
        console.log('DEBUG: Full file content after processing:', updatedContent.substring(0, 500));
        
        // Add a delayed check to see if something clears the frontmatter later
        setTimeout(async () => {
          try {
            const delayedContent = await this.plugin.app.vault.read(file);
            console.log('DEBUG: File content after 1 second delay:', delayedContent.substring(0, 500));
            if (!delayedContent.includes('wp_url:') && updatedContent.includes('wp_url:')) {
              console.error('ERROR: Frontmatter was cleared AFTER our preservation logic!');
            }
          } catch (error) {
            console.log('DEBUG: Could not read file after delay:', error);
          }
        }, 1000);
      }

      if (postId) {
        if (this.plugin.settings.rememberLastSelectedCategories) {
          // Save category names instead of IDs
          try {
            const auth = await this.getAuth();
            const categoryIds = (result.data as SafeAny).categories as number[];
            this.profile.lastSelectedCategories = await this.convertCategoryIdsToNames(categoryIds, auth);
          } catch (error) {
            console.warn('Could not convert category IDs to names for saving:', error);
            // Fallback to saving IDs if conversion fails
            this.profile.lastSelectedCategories = (result.data as SafeAny).categories;
          }
          await this.plugin.saveSettings();
        }

        if (this.plugin.settings.showWordPressEditConfirm) {
          openPostPublishedModal(this.plugin)
            .then(() => {
              openWithBrowser(`${this.profile.endpoint}/wp-admin/post.php`, {
                action: 'edit',
                post: postId
              });
            });
        }
      }
    }
    return result;
  }

  private async updatePostImages(params: {
    postParams: WordPressPostParams,
    auth: WordPressAuthParams,
  }): Promise<void> {
    const { postParams, auth } = params;

    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (activeFile === null) {
      throw new Error(this.plugin.i18n.t('error_noActiveFile'));
    }
    const { activeEditor } = this.plugin.app.workspace;
    if (activeEditor && activeEditor.editor) {
      // process images
      const images = getImages(postParams.content);
      for (const img of images) {
        if (!img.srcIsUrl) {
          img.src = decodeURI(img.src);
          const fileName = img.src.split("/").pop();
          if (fileName === undefined) {
            continue;
          }
          const imgFile = this.plugin.app.metadataCache.getFirstLinkpathDest(img.src, fileName);
          if (imgFile instanceof TFile) {
            const content = await this.plugin.app.vault.readBinary(imgFile);
            const fileType = fileTypeChecker.detectFile(content);
            const result = await this.uploadMedia({
              mimeType: fileType?.mimeType ?? 'application/octet-stream',
              fileName: imgFile.name,
              content: content
            }, auth);
            if (result.code === WordPressClientReturnCode.OK) {
              if(img.width && img.height){
                  postParams.content = postParams.content.replace(img.original, `![[${result.data.url}|${img.width}x${img.height}]]`);
              }else if (img.width){
                  postParams.content = postParams.content.replace(img.original, `![[${result.data.url}|${img.width}]]`);
              }else{
                  postParams.content = postParams.content.replace(img.original, `![[${result.data.url}]]`);
              }
            } else {
              if (result.error.code === WordPressClientReturnCode.ServerInternalError) {
                new Notice(result.error.message, ERROR_NOTICE_TIMEOUT);
              } else {
                new Notice(this.plugin.i18n.t('error_mediaUploadFailed', {
                  name: imgFile.name,
                }), ERROR_NOTICE_TIMEOUT);
              }
            }
          }
        } else {
          // src is a url, skip uploading
        }
      }
      if (this.plugin.settings.replaceMediaLinks) {
        console.log('DEBUG: About to call activeEditor.editor.setValue - this might clear frontmatter!');
        console.log('DEBUG: Current file content before setValue:', await this.plugin.app.vault.read(activeFile));
        console.log('DEBUG: Content being set:', postParams.content.substring(0, 500));
        activeEditor.editor.setValue(postParams.content);
        console.log('DEBUG: Content after setValue:', await this.plugin.app.vault.read(activeFile));
      }
    }
  }

  async publishPost(defaultPostParams?: WordPressPostParams): Promise<WordPressClientResult<WordPressPublishResult>> {
    try {
      // Prevent multiple simultaneous publishes
      if (AbstractWordPressClient.publishInProgress) {
        console.log('DEBUG: Publish already in progress, preventing race condition');
        throw new Error('A publish operation is already in progress. Please wait for it to complete.');
      }
      
      AbstractWordPressClient.publishInProgress = true;
      console.log('DEBUG: Publish lock acquired');
      
      if (!this.profile.endpoint || this.profile.endpoint.length === 0) {
        throw new Error(this.plugin.i18n.t('error_noEndpoint'));
      }
      // const { activeEditor } = this.plugin.app.workspace;
      const file = this.plugin.app.workspace.getActiveFile()
      if (file === null) {
        throw new Error(this.plugin.i18n.t('error_noActiveFile'));
      }

      // get auth info
      const auth = await this.getAuth();

      // read note title, content and matter data
      const title = file.basename;
      const { content, matter: matterData } = await processFile(file, this.plugin.app);
      
      console.log('DEBUG: Initial matterData after processFile =', JSON.stringify(matterData));
      
      // Safety check: If this file previously had WordPress frontmatter but now doesn't,
      // something went wrong - don't create a new post accidentally
      const fileContent = await this.plugin.app.vault.read(file);
      const hasWpFrontmatterText = fileContent.includes('wp_url:') || fileContent.includes('wp_profile:') || 
                                   fileContent.includes('wp_ptype:') || fileContent.includes('wp_categories:');
      const hasWpFrontmatterParsed = Object.keys(matterData).some(key => key.startsWith('wp_'));
      
      console.log('DEBUG: hasWpFrontmatterText =', hasWpFrontmatterText, 'hasWpFrontmatterParsed =', hasWpFrontmatterParsed);
      
      if (hasWpFrontmatterText && !hasWpFrontmatterParsed) {
        console.log('ERROR: WordPress frontmatter found in file text but not parsed!');
        console.log('Raw file content (first 500 chars):', fileContent.substring(0, 500));
        console.log('Parsed matterData:', JSON.stringify(matterData));
        throw new Error('WordPress frontmatter parsing failed. Please check the YAML syntax in your frontmatter and try again.');
      }
      
      // Additional safety: If no frontmatter was parsed but file has content,
      // wait a moment and re-read to handle potential race conditions
      if (!hasWpFrontmatterParsed && file.stat.size > 0) {
        console.log('DEBUG: No frontmatter parsed, waiting 100ms and re-reading file...');
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const { matter: retryMatterData } = await processFile(file, this.plugin.app);
        const hasWpFrontmatterRetry = Object.keys(retryMatterData).some(key => key.startsWith('wp_'));
        
        if (hasWpFrontmatterRetry) {
          console.log('DEBUG: Frontmatter found on retry, using retry data');
          Object.assign(matterData, retryMatterData);
        } else {
          console.log('DEBUG: Still no frontmatter on retry, proceeding as new post');
        }
      }
      
      // check if profile selected is matched to the one in note property,
      // if not, ask whether to update or not
      await this.checkExistingProfile(matterData);
      
      console.log('DEBUG: matterData after checkExistingProfile =', JSON.stringify(matterData));

      // now we're preparing the publishing data
      let postParams: WordPressPostParams;
      let result: WordPressClientResult<WordPressPublishResult> | undefined;
      
      // Check if this is an update (wp_url exists) vs new post
      const hasExistingPost = matterData.wp_url && matterData.wp_url.length > 0;
      
      if (defaultPostParams || hasExistingPost) {
        // Use existing parameters or create default ones for updates
        let categoriesForAPI: number[] = [1]; // Default fallback
        
        // Handle categories from matterData (could be names or IDs)
        if (matterData.wp_categories && Array.isArray(matterData.wp_categories) && matterData.wp_categories.length > 0) {
          if (typeof matterData.wp_categories[0] === 'string') {
            // Convert category names to IDs for API calls
            categoriesForAPI = await this.convertCategoryNamesToIds(matterData.wp_categories as string[], auth);
          } else {
            // Legacy format - categories are already IDs
            categoriesForAPI = matterData.wp_categories as number[];
          }
        } else if (this.profile.lastSelectedCategories && this.profile.lastSelectedCategories.length > 0) {
          // Handle profile categories (could be names or IDs)
          if (typeof this.profile.lastSelectedCategories[0] === 'string') {
            // Convert profile category names to IDs
            categoriesForAPI = await this.convertCategoryNamesToIds(this.profile.lastSelectedCategories as string[], auth);
          } else {
            // Profile categories are IDs
            categoriesForAPI = this.profile.lastSelectedCategories as number[];
          }
        }
        
        const baseParams = defaultPostParams || {
          status: this.plugin.settings.defaultPostStatus,
          commentStatus: this.plugin.settings.defaultCommentStatus,
          postType: matterData.wp_ptype ?? PostTypeConst.Post,
          categories: categoriesForAPI,
          tags: (matterData.wp_tags as string[]) ?? [],
          title: '',
          content: ''
        };
        
        postParams = await this.readFromFrontMatter(title, matterData, baseParams);
        postParams.content = content;
        result = await this.tryToPublish({
          auth,
          postParams,
          originalTagNames: (matterData.wp_tags as string[]) ?? []
        });
      } else {
        const categories = await this.getCategories(auth);
        
        // Handle selected categories from frontmatter (could be names or IDs)
        let selectedCategories: number[] = [1]; // Default fallback
        
        if (matterData.wp_categories && Array.isArray(matterData.wp_categories) && matterData.wp_categories.length > 0) {
          if (typeof matterData.wp_categories[0] === 'string') {
            // Convert category names to IDs for the modal
            selectedCategories = await this.convertCategoryNamesToIds(matterData.wp_categories as string[], auth);
          } else {
            // Legacy format - categories are already IDs
            selectedCategories = matterData.wp_categories as number[];
          }
        } else if (this.profile.lastSelectedCategories && this.profile.lastSelectedCategories.length > 0) {
          // Handle profile categories (could be names or IDs)
          if (typeof this.profile.lastSelectedCategories[0] === 'string') {
            // Convert profile category names to IDs
            selectedCategories = await this.convertCategoryNamesToIds(this.profile.lastSelectedCategories as string[], auth);
          } else {
            // Profile categories are IDs
            selectedCategories = this.profile.lastSelectedCategories as number[];
          }
        }
        
        const postTypes = await this.getPostTypes(auth);
        if (postTypes.length === 0) {
          postTypes.push(PostTypeConst.Post);
        }
        const selectedPostType = matterData.wp_ptype ?? PostTypeConst.Post;
        result = await new Promise(resolve => {
          const publishModal = new WpPublishModal(
            this.plugin,
            { items: categories, selected: selectedCategories },
            { items: postTypes, selected: selectedPostType },
            async (postParams: WordPressPostParams, updateMatterData: (matter: MatterData) => void) => {
              postParams = await this.readFromFrontMatter(title, matterData, postParams);
              postParams.content = content;
              // For modal case, preserve the original tags from frontmatter since modal doesn't handle tags
              const originalTagsForModal = (matterData.wp_tags as string[]) ?? [];
              try {
                const r = await this.tryToPublish({
                  auth,
                  postParams,
                  updateMatterData,
                  originalTagNames: originalTagsForModal
                });
                if (r.code === WordPressClientReturnCode.OK) {
                  publishModal.close();
                  resolve(r);
                }
              } catch (error) {
                if (error instanceof Error) {
                  return showError(error);
                } else {
                  throw error;
                }
              }
            },
            matterData);
          publishModal.open();
        });
      }
      if (result) {
        console.log('DEBUG: publishPost about to return, checking final file state...');
        const finalFile = this.plugin.app.workspace.getActiveFile();
        if (finalFile) {
          const finalContent = await this.plugin.app.vault.read(finalFile);
          console.log('DEBUG: Final file content at end of publishPost:', finalContent.substring(0, 500));
        }
        return result;
      } else {
        throw new Error(this.plugin.i18n.t("message_publishFailed"));
      }
    } catch (error) {
      if (error instanceof Error) {
        return showError(error);
      } else {
        throw error;
      }
    } finally {
      AbstractWordPressClient.publishInProgress = false;
      console.log('DEBUG: Publish lock released');
    }
  }

  private async getTags(tags: string[], certificate: WordPressAuthParams): Promise<Term[]> {
    const results = await Promise.allSettled(tags.map(name => this.getTag(name, certificate)));
    const terms: Term[] = [];
    results
      .forEach(result => {
        if (isPromiseFulfilledResult<Term>(result)) {
          terms.push(result.value);
        }
      });
    return terms;
  }

  private async readFromFrontMatter(
    noteTitle: string,
    matterData: MatterData,
    params: WordPressPostParams
  ): Promise<WordPressPostParams> {
    const postParams = { ...params };
    postParams.title = noteTitle;
    if (matterData.wp_title) {
      postParams.title = matterData.wp_title;
    }
    if (matterData.wp_url) {
      // Convert URL to post ID for API calls (now properly handles slugs)
      const postId = await this.extractPostIdFromUrl(matterData.wp_url);
      if (postId) {
        postParams.postId = String(postId); // Convert number to string as expected by interface
      }
    }
    postParams.profileName = matterData.wp_profile ?? WP_DEFAULT_PROFILE_NAME;
    if (matterData.wp_ptype !== undefined) {
      postParams.postType = matterData.wp_ptype;
    } else {
      // if there is no post type in matter-data, assign it as 'post'
      postParams.postType = PostTypeConst.Post;
    }
    if (postParams.postType === PostTypeConst.Post) {
      // only 'post' supports categories and tags
      if (matterData.wp_categories !== undefined) {
        // Check if categories are stored as names (new format) or IDs (legacy format)
        const wpCategories = matterData.wp_categories;
        if (Array.isArray(wpCategories) && wpCategories.length > 0) {
          // Check if first item is a string (name) or number (ID)
          if (typeof wpCategories[0] === 'string') {
            // Convert category names to IDs for API calls
            const auth = await this.getAuth();
            postParams.categories = await this.convertCategoryNamesToIds(wpCategories as string[], auth);
          } else {
            // Legacy format - categories are already IDs
            postParams.categories = wpCategories as number[];
          }
        } else {
          // Use profile default categories
          if (this.profile.lastSelectedCategories && this.profile.lastSelectedCategories.length > 0) {
            if (typeof this.profile.lastSelectedCategories[0] === 'string') {
              // Convert profile category names to IDs
              const auth = await this.getAuth();
              postParams.categories = await this.convertCategoryNamesToIds(this.profile.lastSelectedCategories as string[], auth);
            } else {
              // Profile categories are IDs
              postParams.categories = this.profile.lastSelectedCategories as number[];
            }
          } else {
            postParams.categories = [1];
          }
        }
      }
      if (matterData.wp_tags !== undefined) {
        postParams.tags = matterData.wp_tags as string[];
      }
    }
    return postParams;
  }

}

interface Image {
  original: string;
  src: string;
  altText?: string;
  width?: string;
  height?: string;
  srcIsUrl: boolean;
  startIndex: number;
  endIndex: number;
  file?: TFile;
  content?: ArrayBuffer;
}

function getImages(content: string): Image[] {
  const paths: Image[] = [];

  // for ![Alt Text](image-url)
  let regex = /(!\[(.*?)(?:\|(\d+)(?:x(\d+))?)?]\((.*?)\))/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    paths.push({
      src: match[5],
      altText: match[2],
      width: match[3],
      height: match[4],
      original: match[1],
      startIndex: match.index,
      endIndex: match.index + match.length,
      srcIsUrl: isValidUrl(match[5]),
    });
  }

  // for ![[image-name]]
  regex = /(!\[\[(.*?)(?:\|(\d+)(?:x(\d+))?)?]])/g;
  while ((match = regex.exec(content)) !== null) {
    paths.push({
      src: match[2],
      original: match[1],
      width: match[3],
      height: match[4],
      startIndex: match.index,
      endIndex: match.index + match.length,
      srcIsUrl: isValidUrl(match[2]),
    });
  }

  return paths;
}
