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

  private async checkExistingProfile(matterData: MatterData) {
    const { wp_profile } = matterData;
    const isProfileNameMismatch = wp_profile && wp_profile !== this.profile.name;
    if (isProfileNameMismatch) {
      const confirm = await openConfirmModal({
        message: this.plugin.i18n.t('error_profileNotMatch'),
        cancelText: this.plugin.i18n.t('profileNotMatch_useOld', {
          profileName: matterData.wp_profile
        }),
        confirmText: this.plugin.i18n.t('profileNotMatch_useNew', {
          profileName: this.profile.name
        })
      }, this.plugin);
      if (confirm.code !== ConfirmCode.Cancel) {
        delete matterData.wp_url;
        matterData.wp_categories = this.profile.lastSelectedCategories ?? [ 1 ];
      }
    }
  }

  private async tryToPublish(params: {
    postParams: WordPressPostParams,
    auth: WordPressAuthParams,
    updateMatterData?: (matter: MatterData) => void,
  }): Promise<WordPressClientResult<WordPressPublishResult>> {
    const { postParams, auth, updateMatterData } = params;
    const tagTerms = await this.getTags(postParams.tags, auth);
    postParams.tags = tagTerms.map(term => term.id);
    await this.updatePostImages({
      auth,
      postParams
    });
    const html = AppState.markdownParser.render(postParams.content);
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
        console.log('DEBUG: postParams =', JSON.stringify(postParams));
        
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
          
          // Handle URL - only update if we have new info
          if (postId && result.data.postUrl) {
            fm.wp_url = result.data.postUrl;
          } else if (postId && !preserved.wp_url) {
            fm.wp_url = `${this.profile.endpoint}/?p=${postId}`;
          } else if (preserved.wp_url) {
            fm.wp_url = preserved.wp_url; // Keep existing URL
          }
          
          // Preserve other fields - never delete them
          if (preserved.wp_ptype) {
            fm.wp_ptype = preserved.wp_ptype;
          }
          if (preserved.wp_categories !== undefined) {
            fm.wp_categories = preserved.wp_categories;
          }
          if (preserved.wp_tags !== undefined) {
            fm.wp_tags = preserved.wp_tags;
          }
          if (preserved.wp_title) {
            fm.wp_title = preserved.wp_title;
          }
          
          console.log('DEBUG: Preserved values =', JSON.stringify(preserved));
          console.log('DEBUG: Final frontmatter =', JSON.stringify(fm));
          
          // Run any additional updates from modal, but after our preservation
          if (isFunction(updateMatterData)) {
            updateMatterData(fm);
            console.log('DEBUG: After updateMatterData =', JSON.stringify(fm));
          }
        });
        
        console.log('DEBUG: Frontmatter update completed');
      }

      if (postId) {
        if (this.plugin.settings.rememberLastSelectedCategories) {
          this.profile.lastSelectedCategories = (result.data as SafeAny).categories;
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
        activeEditor.editor.setValue(postParams.content);
      }
    }
  }

  async publishPost(defaultPostParams?: WordPressPostParams): Promise<WordPressClientResult<WordPressPublishResult>> {
    try {
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
      
      // check if profile selected is matched to the one in note property,
      // if not, ask whether to update or not
      await this.checkExistingProfile(matterData);

      // now we're preparing the publishing data
      let postParams: WordPressPostParams;
      let result: WordPressClientResult<WordPressPublishResult> | undefined;
      
      // Check if this is an update (wp_url exists) vs new post
      const hasExistingPost = matterData.wp_url && matterData.wp_url.length > 0;
      
      if (defaultPostParams || hasExistingPost) {
        // Use existing parameters or create default ones for updates
        const baseParams = defaultPostParams || {
          status: this.plugin.settings.defaultPostStatus,
          commentStatus: this.plugin.settings.defaultCommentStatus,
          postType: matterData.wp_ptype ?? PostTypeConst.Post,
          categories: (matterData.wp_categories as number[]) ?? this.profile.lastSelectedCategories ?? [1],
          tags: (matterData.wp_tags as string[]) ?? [],
          title: '',
          content: ''
        };
        
        postParams = await this.readFromFrontMatter(title, matterData, baseParams);
        postParams.content = content;
        result = await this.tryToPublish({
          auth,
          postParams
        });
      } else {
        const categories = await this.getCategories(auth);
        const selectedCategories = matterData.wp_categories as number[]
          ?? this.profile.lastSelectedCategories
          ?? [ 1 ];
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
              try {
                const r = await this.tryToPublish({
                  auth,
                  postParams,
                  updateMatterData
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
        postParams.categories = matterData.wp_categories as number[] ?? this.profile.lastSelectedCategories;
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
